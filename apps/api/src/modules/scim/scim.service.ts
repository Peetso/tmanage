import { isAiEmployeeEmail, uuidv7 } from '@tmanage/domain';
import type { StorageHoldsHook } from '../storage-root/storage-holds.js';
import type { Principal } from '@tmanage/domain';
import {
  createServiceContext,
  type TenantContext,
  type TenantDatabase,
  type TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { AuditService } from '../audit/audit.service.js';
import { UserIdentitiesRepository } from '../google-auth/user-identities.repository.js';
import { PeopleTeamsRepository } from '../people/teams.repository.js';
import { emailDomain, parseDomainList } from '../sso/sso-oidc.js';
import { SsoConnectionsRepository } from '../sso/sso-connections.repository.js';
import {
  InviteeAccountExistsError,
  InviteeAccountsRepository,
} from '../tenancy/invitee-accounts.repository.js';
import { MembershipsRepository } from '../tenancy/memberships.repository.js';
import {
  SCIM_BASE_PATH,
  ScimError,
  groupResource,
  hashScimKey,
  listResponse,
  newScimKey,
  parseGroupBody,
  parseGroupPatch,
  parseScimFilter,
  parseScimPage,
  parseUserBody,
  parseUserPatch,
  readScimBearer,
  scimHashMatches,
  scimNotFound,
  scimUnauthorized,
  userResource,
} from './scim-protocol.js';
import {
  MAX_LIVE_KEYS,
  SCIM_BOOTSTRAP_REASON,
  SCIM_BOOTSTRAP_TABLES,
  SCIM_IDENTITY_TABLES,
  ScimRepository,
  type ScimMember,
} from './scim.repository.js';

/**
 * 54-16 — SCIM 2.0 provisioning.
 *
 * **Keys** (owner only; `org.security.manage` at the route): up to five live bearer keys per
 * organization, only while the organization has company sign-in (`sso_connections`). The key is
 * returned once; only its SHA-256 is stored.
 *
 * **Provisioning**: the key alone names the organization. Users are memberships (`id` = membership
 * id, `userName` = the account's address, which must be in the company sign-in domains); a new
 * address gets an unverified account and an `invited` membership that the first company sign-in
 * activates. Deactivation (`active: false` or DELETE) suspends an active member and offboards an
 * invited one; the company owner can never be deactivated through SCIM. A verified account's
 * address and name belong to its owner and are not changed. Groups are people teams. Every change
 * is an audit event (`org.sign_in_policy_changed`, `change: scim_*`).
 */

const SCIM_POLICY_VERSION = 'scim-v2';
const ACTION = 'org.sign_in_policy_changed' as const;

export interface ScimKeyView {
  readonly id: string;
  readonly name: string;
  readonly prefix: string;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
}

/** The owner's view. Mirrors `apps/web/src/lib/api/scim.ts`. */
export interface ScimSettingsView {
  /** False until company sign-in is set up: keys cannot be created. */
  readonly available: boolean;
  readonly baseUrl: string;
  readonly keys: readonly ScimKeyView[];
}

export interface ScimKeyCreatedView {
  readonly key: ScimKeyView;
  /** Shown once. */
  readonly secret: string;
}

export interface ScimCaller {
  readonly organizationId: string;
  readonly keyId: string;
  readonly correlationId: string;
}

export interface ScimServiceDeps {
  readonly database: TenantDatabase;
  readonly webPublicUrl: string;
  readonly audit?: Pick<AuditService, 'record'>;
  readonly repository?: ScimRepository;
  readonly connections?: Pick<SsoConnectionsRepository, 'find'>;
  readonly memberships?: MembershipsRepository;
  readonly teams?: PeopleTeamsRepository;
  readonly identities?: Pick<UserIdentitiesRepository, 'findUserByEmail'>;
  readonly invitees?: Pick<InviteeAccountsRepository, 'insertUser'>;
  readonly now?: () => Date;
  /** 51-17. A deactivated member's company storage is announced to the owners. */
  readonly storageHolds?: Pick<StorageHoldsHook, 'heldBy' | 'announceLeft'>;
}

function requireOwner(principal: Principal): void {
  if (principal.kind !== 'internal' || principal.role !== 'owner') {
    throw new ApiError(403, 'forbidden', 'Only the company owner can manage provisioning keys.');
  }
}

function keyView(row: {
  id: string;
  name: string;
  tokenPrefix: string;
  createdAt: Date;
  lastUsedAt: Date | null;
}): ScimKeyView {
  return {
    id: row.id,
    name: row.name,
    prefix: row.tokenPrefix,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
  };
}

const OWNER_DETAIL = 'The company owner cannot be deactivated through provisioning.';

export class ScimService {
  private readonly repository: ScimRepository;
  private readonly connections: Pick<SsoConnectionsRepository, 'find'>;
  private readonly memberships: MembershipsRepository;
  private readonly teams: PeopleTeamsRepository;
  private readonly identities: Pick<UserIdentitiesRepository, 'findUserByEmail'>;
  private readonly invitees: Pick<InviteeAccountsRepository, 'insertUser'>;
  private readonly now: () => Date;

  constructor(private readonly deps: ScimServiceDeps) {
    this.repository = deps.repository ?? new ScimRepository();
    this.connections = deps.connections ?? new SsoConnectionsRepository();
    this.memberships = deps.memberships ?? new MembershipsRepository();
    this.teams = deps.teams ?? new PeopleTeamsRepository();
    this.identities = deps.identities ?? new UserIdentitiesRepository();
    this.invitees = deps.invitees ?? new InviteeAccountsRepository();
    this.now = deps.now ?? (() => new Date());
  }

  baseUrl(): string {
    return `${this.deps.webPublicUrl.replace(/\/+$/u, '')}${SCIM_BASE_PATH}`;
  }

  // ── Owner: keys ────────────────────────────────────────────────────────────

  async settings(context: TenantContext, principal: Principal): Promise<ScimSettingsView> {
    requireOwner(principal);
    return this.deps.database.read(context, async (runner) => {
      const connection = await this.connections.find(runner, context);
      const keys = await this.repository.listLiveKeys(runner, context);
      return { available: connection !== null, baseUrl: this.baseUrl(), keys: keys.map(keyView) };
    });
  }

  async createKey(
    context: TenantContext,
    principal: Principal,
    body: unknown,
  ): Promise<ScimKeyCreatedView> {
    requireOwner(principal);
    const raw =
      typeof body === 'object' && body !== null
        ? (body as Record<string, unknown>)['name']
        : undefined;
    const name = typeof raw === 'string' ? raw.trim() : '';
    if (name === '' || name.length > 120) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: 'name', message: 'must be 1 to 120 characters' },
      ]);
    }
    const key = newScimKey();
    const id = uuidv7();
    const createdAt = this.now();
    await this.deps.database.transaction(context, async (tx) => {
      if (!(await this.connections.find(tx, context))) {
        throw new ApiError(
          409,
          'conflict',
          'Set up company sign-in before creating provisioning keys.',
        );
      }
      if ((await this.repository.listLiveKeys(tx, context)).length >= MAX_LIVE_KEYS) {
        throw new ApiError(
          409,
          'conflict',
          `An organization can have at most ${MAX_LIVE_KEYS} provisioning keys.`,
        );
      }
      await this.repository.insertKey(tx, context, {
        id,
        name,
        tokenHash: key.hash,
        tokenPrefix: key.prefix,
        createdBy: principal.userId,
        createdAt,
      });
      await this.audit(tx, context, principal.userId, {
        change: 'scim_key_created',
        scim_key_id: id,
      });
    });
    return {
      key: keyView({ id, name, tokenPrefix: key.prefix, createdAt, lastUsedAt: null }),
      secret: key.secret,
    };
  }

  async revokeKey(
    context: TenantContext,
    principal: Principal,
    id: string,
  ): Promise<ScimSettingsView> {
    requireOwner(principal);
    await this.deps.database.transaction(context, async (tx) => {
      if (!(await this.repository.revokeKey(tx, context, id, this.now()))) {
        throw new ApiError(404, 'not_found', MESSAGES.notFound);
      }
      await this.audit(tx, context, principal.userId, {
        change: 'scim_key_revoked',
        scim_key_id: id,
      });
    });
    return this.settings(context, principal);
  }

  // ── Provider: authentication ───────────────────────────────────────────────

  /** The key's organization; 401 for a missing, unknown or revoked key or one without SSO. */
  async authenticate(header: unknown, correlationId: string): Promise<ScimCaller> {
    const secret = readScimBearer(header);
    if (!secret) throw scimUnauthorized();
    const hash = hashScimKey(secret);
    const found = await this.deps.database.bootstrapRead(
      { correlationId, reason: SCIM_BOOTSTRAP_REASON, tables: [...SCIM_BOOTSTRAP_TABLES] },
      async (db) => {
        const row = await this.repository.findKeyByHash(db, hash);
        if (!row || row.revokedAt !== null || !scimHashMatches(row.tokenHash, hash)) return null;
        // Company sign-in removed: provisioning stops with it.
        if (!(await this.repository.hasSsoConnection(db, row.organizationId))) return null;
        return row;
      },
    );
    if (!found) throw scimUnauthorized();
    const caller = { organizationId: found.organizationId, keyId: found.id, correlationId };
    const context = this.context(caller);
    await this.deps.database.transaction(context, (tx) =>
      this.repository.touchKey(tx, context, found.id, this.now()),
    );
    return caller;
  }

  // ── Provider: users ────────────────────────────────────────────────────────

  async listUsers(
    caller: ScimCaller,
    query: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const filter = parseScimFilter(query['filter'], 'User');
    const page = parseScimPage(query);
    const context = this.context(caller);
    return this.deps.database.read(context, async (runner) => {
      const { rows, total } = await this.repository.listUsers(
        runner,
        context,
        filter,
        page.startIndex - 1,
        page.count,
      );
      const records = await this.repository.toUserRecords(runner, context, rows);
      return listResponse(
        records.map((r) => userResource(r, this.baseUrl())),
        total,
        page,
      );
    });
  }

  async getUser(caller: ScimCaller, id: string): Promise<Record<string, unknown>> {
    const context = this.context(caller);
    return this.deps.database.read(context, (runner) => this.userOrThrow(runner, context, id));
  }

  async createUser(caller: ScimCaller, body: unknown): Promise<Record<string, unknown>> {
    const input = parseUserBody(body);
    const context = this.context(caller);
    const connection = await this.deps.database.read(context, (runner) =>
      this.connections.find(runner, context),
    );
    if (!connection) throw scimUnauthorized();
    // 60-04 door: an AI employee's address is never provisioned (it would attach the AI user to
    // this company as a person).
    if (isAiEmployeeEmail(input.email)) {
      throw new ScimError(400, 'userName must be in a company sign-in domain.', 'invalidValue');
    }
    const domain = emailDomain(input.email);
    if (domain === null || !parseDomainList(connection.allowedDomains).includes(domain)) {
      throw new ScimError(400, 'userName must be in a company sign-in domain.', 'invalidValue');
    }
    const userId = await this.accountFor(caller, input.email, input.displayName);
    const membershipId = await this.deps.database.transaction(context, async (tx) => {
      if (await this.memberships.findByUserId(tx, context, userId)) {
        throw new ScimError(409, 'This person is already provisioned.', 'uniqueness');
      }
      const invited = await this.memberships.invite(tx, context, { userId, role: 'member' });
      await this.audit(tx, context, null, {
        change: 'scim_user_created',
        scim_key_id: caller.keyId,
        membership_id: invited.id,
      });
      return invited.id;
    });
    return this.getUser(caller, membershipId);
  }

  async replaceUser(
    caller: ScimCaller,
    id: string,
    body: unknown,
  ): Promise<Record<string, unknown>> {
    const input = parseUserBody(body);
    return this.changeUser(caller, id, {
      email: input.email,
      displayName: input.displayName,
      active: input.active,
    });
  }

  async patchUser(caller: ScimCaller, id: string, body: unknown): Promise<Record<string, unknown>> {
    return this.changeUser(caller, id, parseUserPatch(body));
  }

  /** DELETE → deactivate (never a hard delete). */
  async deleteUser(caller: ScimCaller, id: string): Promise<void> {
    await this.changeUser(caller, id, { active: false });
  }

  private async changeUser(
    caller: ScimCaller,
    id: string,
    change: { email?: string; displayName?: string | undefined; active?: boolean | undefined },
  ): Promise<Record<string, unknown>> {
    const context = this.context(caller);
    const current = await this.deps.database.read(context, (runner) =>
      this.repository.findUser(runner, context, id),
    );
    if (!current) throw scimNotFound();
    if (change.email !== undefined && change.email !== current.email) {
      throw new ScimError(
        400,
        'The address of an account cannot be changed by provisioning.',
        'mutability',
      );
    }
    if (change.active === false && current.role === 'owner') {
      throw new ScimError(400, OWNER_DETAIL, 'mutability');
    }
    if (
      change.displayName !== undefined &&
      change.displayName !== current.displayName &&
      current.emailVerifiedAt === null
    ) {
      await this.deps.database.identityTransaction(
        { correlationId: caller.correlationId, tables: [...SCIM_IDENTITY_TABLES] },
        (tx) => this.repository.renameUnverifiedUser(tx, current.userId, change.displayName!),
      );
    }
    if (change.active !== undefined) await this.setActive(caller, current, change.active);
    if (change.active === false && current.status === 'invited')
      return this.deactivatedInvite(current);
    return this.getUser(caller, id);
  }

  private async setActive(caller: ScimCaller, member: ScimMember, active: boolean): Promise<void> {
    const to = active
      ? member.status === 'suspended'
        ? 'active'
        : null
      : member.status === 'active'
        ? 'suspended'
        : member.status === 'invited'
          ? 'offboarded'
          : null;
    if (to === null) return;
    const context = this.context(caller);
    await this.deps.database.transaction(context, async (tx) => {
      const row = await this.memberships.requireById(tx, context, member.membershipId);
      if (row.role === 'owner' && !active) throw new ScimError(400, OWNER_DETAIL, 'mutability');
      await this.memberships.transitionStatus(tx, context, row.id, row.version, to);
      if (!active && this.deps.storageHolds) {
        const holds = await this.deps.storageHolds.heldBy(tx, context, row.userId);
        await this.deps.storageHolds.announceLeft(
          tx,
          context,
          holds,
          `${row.id}:${String(row.version)}`,
        );
      }
      await this.audit(tx, context, null, {
        change: active ? 'scim_user_reactivated' : 'scim_user_deactivated',
        scim_key_id: caller.keyId,
        membership_id: row.id,
      });
    });
  }

  /** An offboarded invitation is no longer visible; answer with what it was, inactive. */
  private deactivatedInvite(member: ScimMember): Record<string, unknown> {
    return userResource({ ...member, status: 'offboarded', groups: [] }, this.baseUrl());
  }

  private async userOrThrow(
    runner: TenantQueryRunner,
    context: TenantContext,
    id: string,
  ): Promise<Record<string, unknown>> {
    const row = await this.repository.findUser(runner, context, id);
    if (!row) throw scimNotFound();
    const [record] = await this.repository.toUserRecords(runner, context, [row]);
    return userResource(record!, this.baseUrl());
  }

  /** The account using the address, created unverified when there is none. */
  private async accountFor(
    caller: ScimCaller,
    email: string,
    displayName: string | undefined,
  ): Promise<string> {
    const options = { correlationId: caller.correlationId, tables: [...SCIM_IDENTITY_TABLES] };
    const existing = await this.deps.database.identityRead(options, (db) =>
      this.identities.findUserByEmail(db, email),
    );
    if (existing) return existing.userId;
    const id = uuidv7();
    try {
      await this.deps.database.identityTransaction(options, (tx) =>
        this.invitees.insertUser(tx, {
          id,
          email,
          displayName: displayName ?? email.slice(0, email.indexOf('@')),
          locale: 'en',
          timezone: 'UTC',
        }),
      );
      return id;
    } catch (error) {
      if (!(error instanceof InviteeAccountExistsError)) throw error;
      const raced = await this.deps.database.identityRead(options, (db) =>
        this.identities.findUserByEmail(db, email),
      );
      if (!raced) throw error;
      return raced.userId;
    }
  }

  // ── Provider: groups ───────────────────────────────────────────────────────

  async listGroups(
    caller: ScimCaller,
    query: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const filter = parseScimFilter(query['filter'], 'Group');
    const page = parseScimPage(query);
    const context = this.context(caller);
    return this.deps.database.read(context, async (runner) => {
      const all = await this.repository.listGroups(runner, context, filter);
      const slice = all.slice(page.startIndex - 1, page.startIndex - 1 + page.count);
      const records = [];
      for (const team of slice)
        records.push(await this.repository.toGroupRecord(runner, context, team));
      return listResponse(
        records.map((r) => groupResource(r, this.baseUrl())),
        all.length,
        page,
      );
    });
  }

  async getGroup(caller: ScimCaller, id: string): Promise<Record<string, unknown>> {
    const context = this.context(caller);
    return this.deps.database.read(context, async (runner) => {
      const team = await this.teams.findTeamById(runner, context, id);
      if (!team) throw scimNotFound();
      return groupResource(
        await this.repository.toGroupRecord(runner, context, team),
        this.baseUrl(),
      );
    });
  }

  async createGroup(caller: ScimCaller, body: unknown): Promise<Record<string, unknown>> {
    const input = parseGroupBody(body);
    const context = this.context(caller);
    const teamId = await this.deps.database.transaction(context, async (tx) => {
      if (await this.teams.findTeamByName(tx, context, input.displayName)) {
        throw new ScimError(409, 'A group with this name exists.', 'uniqueness');
      }
      const team = await this.teams.createTeam(tx, context, input.displayName);
      await this.setMembers(tx, context, team.id, { replace: input.members });
      await this.audit(tx, context, null, {
        change: 'scim_group_created',
        scim_key_id: caller.keyId,
        team_id: team.id,
      });
      return team.id;
    });
    return this.getGroup(caller, teamId);
  }

  async replaceGroup(
    caller: ScimCaller,
    id: string,
    body: unknown,
  ): Promise<Record<string, unknown>> {
    const input = parseGroupBody(body);
    return this.changeGroup(caller, id, { displayName: input.displayName, replace: input.members });
  }

  async patchGroup(
    caller: ScimCaller,
    id: string,
    body: unknown,
  ): Promise<Record<string, unknown>> {
    const patch = parseGroupPatch(body);
    return this.changeGroup(caller, id, {
      displayName: patch.displayName,
      replace: patch.replaceMembers,
      add: patch.addMembers,
      remove: patch.removeMembers,
    });
  }

  async deleteGroup(caller: ScimCaller, id: string): Promise<void> {
    const context = this.context(caller);
    await this.deps.database.transaction(context, async (tx) => {
      if (!(await this.teams.findTeamById(tx, context, id))) throw scimNotFound();
      await this.repository.deleteGroup(tx, context, id);
      await this.audit(tx, context, null, {
        change: 'scim_group_deleted',
        scim_key_id: caller.keyId,
        team_id: id,
      });
    });
  }

  private async changeGroup(
    caller: ScimCaller,
    id: string,
    change: {
      displayName?: string | undefined;
      replace?: string[] | undefined;
      add?: string[];
      remove?: string[];
    },
  ): Promise<Record<string, unknown>> {
    const context = this.context(caller);
    await this.deps.database.transaction(context, async (tx) => {
      const team = await this.teams.findTeamById(tx, context, id);
      if (!team) throw scimNotFound();
      if (change.displayName !== undefined && change.displayName !== team.name) {
        const clash = await this.teams.findTeamByName(tx, context, change.displayName);
        if (clash && clash.id !== id)
          throw new ScimError(409, 'A group with this name exists.', 'uniqueness');
        await this.repository.renameGroup(tx, context, id, change.displayName);
      }
      await this.setMembers(tx, context, id, change);
      await this.audit(tx, context, null, {
        change: 'scim_group_changed',
        scim_key_id: caller.keyId,
        team_id: id,
      });
    });
    return this.getGroup(caller, id);
  }

  /** Every named member must be a visible membership of this organization (400 otherwise). */
  private async setMembers(
    tx: TenantQueryRunner,
    context: TenantContext,
    teamId: string,
    change: { replace?: string[] | undefined; add?: string[]; remove?: string[] },
  ): Promise<void> {
    const current = new Set(
      (await this.repository.groupMembers(tx, context, teamId)).map((m) => m.membershipId),
    );
    const desired = new Set(change.replace ?? current);
    for (const id of change.add ?? []) desired.add(id);
    for (const id of change.remove ?? []) desired.delete(id);
    const added = [...desired].filter((id) => !current.has(id));
    const found = await this.repository.findUsers(tx, context, added);
    if (found.length !== new Set(added).size) {
      throw new ScimError(400, 'A member is not a user of this organization.', 'invalidValue');
    }
    for (const id of added) await this.teams.createAssignment(tx, context, teamId, id);
    for (const id of current) {
      if (!desired.has(id)) await this.teams.deleteAssignment(tx, context, teamId, id);
    }
  }

  // ── Shared ─────────────────────────────────────────────────────────────────

  private context(caller: ScimCaller): TenantContext {
    return createServiceContext({
      organizationId: caller.organizationId,
      correlationId: caller.correlationId,
      policyVersion: SCIM_POLICY_VERSION,
    });
  }

  private async audit(
    tx: TenantQueryRunner,
    context: TenantContext,
    actorUserId: string | null,
    metadata: Record<string, string>,
  ): Promise<void> {
    await this.deps.audit?.record(tx, context, {
      action: ACTION,
      objectId: context.organizationId,
      result: 'allowed',
      actorUserId,
      metadata,
    });
  }
}

import {
  aiAdminCapabilitiesIn,
  aiEmployeeEmail,
  aiEmployeeStateMachine,
  aiRoleDecision,
  AI_EMPLOYEES_PER_WORKSPACE,
  customRoleKey,
  effectiveCapabilitySet,
  isPlatformSupportRole,
  readStoredAiEmployeeLimits,
  uuidv7,
  type AiEmployeeLimits,
  type AiEmployeeStatus,
  type Capability,
  type Principal,
  type PrincipalRole,
  type WorkingWindow,
} from '@tmanage/domain';
import type {
  AiEmployeeHireScope,
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { AuditService } from '../audit/audit.service.js';
import type { InviteeAccountsRepository } from '../tenancy/invitee-accounts.repository.js';
import type { MembershipsRepository } from '../tenancy/memberships.repository.js';
import {
  capabilitiesOfStoredRole,
  exceedsCaller,
  requireMayGrantRole,
} from '../tenancy/role-grant-ceiling.js';
import {
  parseHire,
  parseSponsorChange,
  parseUpdate,
  parseVersionOnly,
  parseWindows,
  type HireInput,
} from './ai-employees.input.js';
import type {
  AiEmployeeChange,
  AiEmployeeRecord,
  AiEmployeesRepository,
} from './ai-employees.repository.js';

/**
 * 60-03 (plan 60 v2 §2.1, §4.1, §4.5) — hire, list, read, edit, pause, resume, change the sponsor
 * of and retire an AI employee: a member of kind `ai` with a sponsor, a job, limits and hours.
 *
 * Rules applied (ENGINEERING-STANDARD): SE-1 (the route guard chain, then the session-only door
 * below), AR-8 (every decision is the domain's: `aiRoleDecision`, `aiEmployeeStateMachine`, the
 * limit parsers), AR-9 (views carry `can*` decisions), DA-1 (hire: organization row lock against
 * write skew on the cap and the name; edits: conditional UPDATE on `version` against lost update),
 * DA-10 (bound times), DA-11 (one audit row per change in its transaction), DA-12 (tenant-scoped
 * statements only), HT-1 (404 for another workspace's id, 409 for a stale version or a cap),
 * IP-2 (bodies parsed once), IP-4 (expected refusals are `ApiError`s with an audit code).
 *
 * **People only.** Every route here refuses a call that did not come from a person's cookie
 * session (`actorChannel` set = an API key or the connector): an AI principal, an AI employee's
 * own key included, can never hire, change or release an AI employee (§5 test 6 "self-change").
 * The registry lists every route NEVER (`ai_employee_admin`).
 */

export const AI_EMPLOYEE_AUDIT = {
  hired: 'ai_employee.hired',
  updated: 'ai_employee.updated',
  paused: 'ai_employee.paused',
  resumed: 'ai_employee.resumed',
  sponsorChanged: 'ai_employee.sponsor_changed',
  retired: 'ai_employee.retired',
} as const;

export interface WorkingWindowView {
  readonly day: number;
  readonly start: string;
  readonly end: string;
}

/** One AI employee as the routes answer it. No web client yet (S1–S6 are designed first). */
export interface AiEmployeeView {
  readonly id: string;
  readonly membershipId: string;
  readonly displayName: string;
  readonly role: string;
  readonly jobTitle: string;
  readonly departmentKey: string | null;
  readonly vendorLabel: string | null;
  readonly modelLabel: string | null;
  readonly status: AiEmployeeStatus;
  readonly pausedReason: string | null;
  readonly pausedAt: string | null;
  readonly retiredAt: string | null;
  readonly sponsor: { readonly membershipId: string; readonly displayName: string | null };
  readonly timezone: string;
  readonly workingHours: readonly WorkingWindowView[] | null;
  readonly limits: AiEmployeeLimits;
  readonly discloseToClients: boolean;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** AR-9: what the caller may do now (the route capability and the lifecycle, decided here). */
  readonly canEdit: boolean;
  readonly canPause: boolean;
  readonly canResume: boolean;
  readonly canRetire: boolean;
}

export interface AiEmployeeListView {
  readonly aiEmployees: readonly AiEmployeeView[];
  /** The workspace's beta cap and how many are not retired (open question 1). */
  readonly limit: number;
  readonly live: number;
  readonly canHire: boolean;
}

export type AiEmployeesDatabase = Pick<
  TenantDatabase,
  'transaction' | 'read' | 'aiEmployeeHireTransaction'
>;

export interface AiEmployeesServiceOptions {
  readonly database: AiEmployeesDatabase;
  readonly audit: Pick<AuditService, 'record'>;
  readonly repository: AiEmployeesRepository;
  readonly memberships: Pick<
    MembershipsRepository,
    'createAiMember' | 'requireById' | 'transitionStatus'
  >;
  readonly accounts: Pick<InviteeAccountsRepository, 'insertUser'>;
  /**
   * The server switch (`TMANAGE_AI_EMPLOYEES=on`, {@link aiEmployeesEnabled}). Required, so no
   * caller can forget it; while `false` every route is the calm 404 of a feature that does not
   * exist, before any read or write.
   */
  readonly enabled: boolean;
  readonly now?: () => Date;
}

/** The environment variable that turns the AI-employee surface on for this server. */
export const AI_EMPLOYEES_SWITCH = 'TMANAGE_AI_EMPLOYEES';

/**
 * Whether this server exposes the AI-employee surface: only the exact value `on`. Absent, empty,
 * `off`, `ON` or anything else is off (fail closed). It stays off until 60-04, 60-05, 60-06 and
 * 60-09 (seats and headcount) have shipped; the platform owner then sets it in Hostinger.
 */
export function aiEmployeesEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
  return env[AI_EMPLOYEES_SWITCH] === 'on';
}

/** The refusal while the switch is off: the same 404 as a feature flag that is off (52-24). */
export function aiEmployeesOff(): ApiError {
  return new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'feature.ai_employees_off');
}

const MANAGE: Capability = 'ai_employee.manage';
const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

function validation(issues: readonly { field: string; message: string }[]): ApiError {
  return new ApiError(400, 'validation_failed', 'The AI employee request is not valid.', [
    ...issues,
  ]);
}

function notFound(cause: string): ApiError {
  return new ApiError(404, 'not_found', 'Not found.', undefined, cause);
}

function conflict(cause: string, message: string): ApiError {
  return new ApiError(409, 'conflict', message, undefined, cause);
}

function minuteText(minute: number): string {
  if (minute === 1440) return '24:00';
  return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
}

function windowsJson(windows: readonly WorkingWindow[] | null): string | null {
  if (windows === null) return null;
  return JSON.stringify(
    windows.map((w) => ({
      day: w.day,
      start: minuteText(w.startMinute),
      end: minuteText(w.endMinute),
    })),
  );
}

function readWindows(stored: string | null, timezone: string): readonly WorkingWindowView[] | null {
  if (stored === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(stored);
  } catch {
    return null;
  }
  const parsed = parseWindows(raw, timezone);
  if (!parsed.ok || parsed.value === null) return null;
  return parsed.value.map((w) => ({
    day: w.day,
    start: minuteText(w.startMinute),
    end: minuteText(w.endMinute),
  }));
}

export class AiEmployeesService {
  private readonly now: () => Date;

  constructor(private readonly options: AiEmployeesServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async list(context: TenantContext, principal: Principal): Promise<AiEmployeeListView> {
    this.requireEnabled();
    requirePersonSession(context, principal);
    const rows = await this.options.database.read(context, (db) =>
      this.options.repository.list(db, context),
    );
    const live = rows.filter((row) => row.status !== 'retired').length;
    const manager = context.capabilities.includes(MANAGE);
    return {
      aiEmployees: rows.map((row) => this.view(row, manager)),
      limit: AI_EMPLOYEES_PER_WORKSPACE,
      live,
      canHire: manager && live < AI_EMPLOYEES_PER_WORKSPACE,
    };
  }

  async get(context: TenantContext, principal: Principal, id: string): Promise<AiEmployeeView> {
    this.requireEnabled();
    requirePersonSession(context, principal);
    const row = await this.options.database.read(context, (db) => this.find(db, context, id));
    return this.view(row, context.capabilities.includes(MANAGE));
  }

  async hire(context: TenantContext, principal: Principal, body: unknown): Promise<AiEmployeeView> {
    this.requireEnabled();
    requirePersonSession(context, principal);
    const parsed = parseHire(body);
    if (!parsed.ok) throw validation(parsed.issues);
    const input = parsed.value;
    const at = this.now();
    const id = await this.options.database.aiEmployeeHireTransaction(context, (scope) =>
      this.hireIn(scope, context, principal, input, at),
    );
    const row = await this.options.database.read(context, (db) => this.find(db, context, id));
    return this.view(row, true);
  }

  async update(
    context: TenantContext,
    principal: Principal,
    id: string,
    body: unknown,
  ): Promise<AiEmployeeView> {
    this.requireEnabled();
    requirePersonSession(context, principal);
    const parsed = parseUpdate(body);
    if (!parsed.ok) throw validation(parsed.issues);
    const input = parsed.value;
    const at = this.now();
    return this.change(context, id, input.version, at, async (tx, current) => {
      if (current.status === 'retired') {
        throw conflict('ai_employee:retired', 'A retired AI employee cannot be changed.');
      }
      const timezone = input.timezone ?? current.timezone;
      const change: {
        -readonly [K in keyof AiEmployeeChange]: AiEmployeeChange[K];
      } = {};
      if (input.jobTitle !== undefined) change.jobTitle = input.jobTitle;
      if (input.departmentKey !== undefined) change.departmentKey = input.departmentKey;
      if (input.vendorLabel !== undefined) change.vendorLabel = input.vendorLabel;
      if (input.modelLabel !== undefined) change.modelLabel = input.modelLabel;
      if (input.timezone !== undefined) change.timezone = input.timezone;
      if (input.limits !== undefined) change.limitsJson = JSON.stringify(input.limits);
      if (input.discloseToClients !== undefined) change.discloseToClients = input.discloseToClients;
      if (input.workingHours !== undefined) {
        const windows = parseWindows(input.workingHours, timezone);
        if (!windows.ok) throw validation(windows.issues);
        change.workingHoursJson = windowsJson(windows.value);
      }
      await this.options.audit.record(tx, context, {
        action: AI_EMPLOYEE_AUDIT.updated,
        result: 'allowed',
        objectId: id,
        actorUserId: context.userId,
        metadata: { fields: Object.keys(change).sort().join(',') },
      });
      return change;
    });
  }

  async pause(
    context: TenantContext,
    principal: Principal,
    id: string,
    body: unknown,
  ): Promise<AiEmployeeView> {
    this.requireEnabled();
    requirePersonSession(context, principal);
    const parsed = parseVersionOnly(body);
    if (!parsed.ok) throw validation(parsed.issues);
    const at = this.now();
    return this.change(context, id, parsed.value.version, at, async (tx, current) => {
      const move = aiEmployeeStateMachine.transition(current.status, 'paused', {
        pausedReason: 'manual',
      });
      if (!move.ok)
        throw conflict('ai_employee:not_active', 'Only an active AI employee can be paused.');
      await this.options.audit.record(tx, context, {
        action: AI_EMPLOYEE_AUDIT.paused,
        result: 'allowed',
        objectId: id,
        actorUserId: context.userId,
        metadata: { reason: 'manual' },
      });
      return { status: 'paused', pausedReason: 'manual', pausedAt: at };
    });
  }

  async resume(
    context: TenantContext,
    principal: Principal,
    id: string,
    body: unknown,
  ): Promise<AiEmployeeView> {
    this.requireEnabled();
    requirePersonSession(context, principal);
    const parsed = parseVersionOnly(body);
    if (!parsed.ok) throw validation(parsed.issues);
    const at = this.now();
    return this.change(context, id, parsed.value.version, at, async (tx, current) => {
      const sponsorOk = await this.sponsorIsActivePerson(tx, context, current.sponsorMembershipId);
      const move = aiEmployeeStateMachine.transition(current.status, 'active', {
        activeSponsor: sponsorOk ? true : null,
      });
      if (!move.ok) {
        throw move.reason === 'missing_requirement'
          ? conflict(
              'ai_employee:sponsor_not_active',
              'Choose a sponsor who is an active person before resuming.',
            )
          : conflict('ai_employee:not_paused', 'Only a paused AI employee can be resumed.');
      }
      await this.options.audit.record(tx, context, {
        action: AI_EMPLOYEE_AUDIT.resumed,
        result: 'allowed',
        objectId: id,
        actorUserId: context.userId,
        metadata: { previous_reason: current.pausedReason ?? 'none' },
      });
      return { status: 'active', pausedReason: null, pausedAt: null };
    });
  }

  async changeSponsor(
    context: TenantContext,
    principal: Principal,
    id: string,
    body: unknown,
  ): Promise<AiEmployeeView> {
    this.requireEnabled();
    requirePersonSession(context, principal);
    const parsed = parseSponsorChange(body);
    if (!parsed.ok) throw validation(parsed.issues);
    const { version, sponsorMembershipId } = parsed.value;
    const at = this.now();
    return this.change(context, id, version, at, async (tx, current) => {
      if (current.status === 'retired') {
        throw conflict('ai_employee:retired', 'A retired AI employee cannot be changed.');
      }
      if (!(await this.sponsorIsActivePerson(tx, context, sponsorMembershipId))) {
        throw validation([
          { field: 'sponsorMembershipId', message: 'must be an active person in this workspace' },
        ]);
      }
      await this.options.audit.record(tx, context, {
        action: AI_EMPLOYEE_AUDIT.sponsorChanged,
        result: 'allowed',
        objectId: id,
        actorUserId: context.userId,
        metadata: {
          previous_sponsor_membership_id: current.sponsorMembershipId,
          sponsor_membership_id: sponsorMembershipId,
        },
      });
      return { sponsorMembershipId };
    });
  }

  /**
   * Retire: the companion row becomes `retired` and the membership `offboarded` in one
   * transaction, so every credential bound to the membership stops at the next resolution (the
   * membership resolver admits active members only). Nothing is deleted: the history keeps its
   * author. Open assignments returning to their supervisors is 60-21's sweep.
   */
  async retire(
    context: TenantContext,
    principal: Principal,
    id: string,
    body: unknown,
  ): Promise<AiEmployeeView> {
    this.requireEnabled();
    requirePersonSession(context, principal);
    const parsed = parseVersionOnly(body);
    if (!parsed.ok) throw validation(parsed.issues);
    const at = this.now();
    return this.change(context, id, parsed.value.version, at, async (tx, current) => {
      const move = aiEmployeeStateMachine.transition(current.status, 'retired', {
        retiredByMembershipId: context.membershipId,
      });
      if (!move.ok) throw conflict('ai_employee:retired', 'This AI employee is already retired.');
      const member = await this.options.memberships.requireById(tx, context, current.membershipId);
      if (member.status !== 'offboarded') {
        await this.options.memberships.transitionStatus(
          tx,
          context,
          current.membershipId,
          member.version,
          'offboarded',
        );
      }
      await this.options.audit.record(tx, context, {
        action: AI_EMPLOYEE_AUDIT.retired,
        result: 'allowed',
        objectId: id,
        actorUserId: context.userId,
        metadata: { membership_id: current.membershipId, previous_status: current.status },
      });
      return { status: 'retired', retiredAt: at, retiredByMembershipId: context.membershipId };
    });
  }

  /** Off: 404 before anything else runs, so the surface does not exist for any caller. */
  private requireEnabled(): void {
    if (!this.options.enabled) throw aiEmployeesOff();
  }

  view(row: AiEmployeeRecord, manager: boolean): AiEmployeeView {
    const live = row.status !== 'retired';
    return {
      id: row.id,
      membershipId: row.membershipId,
      displayName: row.displayName,
      role: row.role,
      jobTitle: row.jobTitle,
      departmentKey: row.departmentKey,
      vendorLabel: row.vendorLabel,
      modelLabel: row.modelLabel,
      status: row.status,
      pausedReason: row.pausedReason,
      pausedAt: iso(row.pausedAt),
      retiredAt: iso(row.retiredAt),
      sponsor: { membershipId: row.sponsorMembershipId, displayName: row.sponsorDisplayName },
      timezone: row.timezone,
      workingHours: readWindows(row.workingHoursJson, row.timezone),
      limits: readStoredAiEmployeeLimits(row.limitsJson),
      discloseToClients: row.discloseToClients,
      version: row.version,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      canEdit: manager && live,
      canPause: manager && aiEmployeeStateMachine.allowedFrom(row.status).includes('paused'),
      canResume: manager && aiEmployeeStateMachine.allowedFrom(row.status).includes('active'),
      canRetire: manager && live,
    };
  }

  // ---- internals ----

  private async hireIn(
    scope: AiEmployeeHireScope,
    context: TenantContext,
    principal: Principal,
    input: HireInput,
    at: Date,
  ): Promise<string> {
    const tx = scope.tenant;
    const repo = this.options.repository;
    // DA-1: the organization row first, always, so the cap and the name are checked serially.
    await repo.lockOrganization(tx, context);
    if ((await repo.countLive(tx, context)) >= AI_EMPLOYEES_PER_WORKSPACE) {
      throw conflict(
        'ai_employee:workspace_limit',
        `A workspace can have ${AI_EMPLOYEES_PER_WORKSPACE} AI employees in the beta.`,
      );
    }
    if (await repo.liveNameTaken(tx, context, input.displayName)) {
      throw conflict('ai_employee:name_taken', 'An AI employee already has this name.');
    }
    const sponsorId = input.sponsorMembershipId ?? context.membershipId;
    if (!(await this.sponsorIsActivePerson(tx, context, sponsorId))) {
      throw validation([
        { field: 'sponsorMembershipId', message: 'must be an active person in this workspace' },
      ]);
    }
    const role = await this.decideRole(tx, context, principal, input);

    const userId = uuidv7();
    const membershipId = uuidv7();
    const id = uuidv7();
    await this.options.accounts.insertUser(scope.identity, {
      id: userId,
      email: aiEmployeeEmail(userId),
      displayName: input.displayName,
      locale: 'en',
      timezone: input.timezone,
    });
    await this.options.memberships.createAiMember(tx, context, {
      id: membershipId,
      userId,
      role,
      at,
    });
    await repo.insert(tx, context, {
      id,
      membershipId,
      userId,
      sponsorMembershipId: sponsorId,
      createdByMembershipId: context.membershipId,
      jobTitle: input.jobTitle,
      departmentKey: input.departmentKey,
      vendorLabel: input.vendorLabel,
      modelLabel: input.modelLabel,
      timezone: input.timezone,
      workingHoursJson: windowsJson(input.workingWindows),
      limitsJson: JSON.stringify(input.limits),
      discloseToClients: input.discloseToClients,
      at,
    });
    await this.options.audit.record(tx, context, {
      action: AI_EMPLOYEE_AUDIT.hired,
      result: 'allowed',
      objectId: id,
      actorUserId: context.userId,
      metadata: {
        membership_id: membershipId,
        role: typeof input.role === 'string' ? input.role : 'custom',
        sponsor_membership_id: sponsorId,
        department_key: input.departmentKey ?? 'none',
      },
    });
    return id;
  }

  /**
   * The stored role value, after three checks: the AI ceiling (member, guest, or a custom role
   * without an admin capability), and the caller's own ceiling ("a creator cannot grant what
   * they lack", T-5): the built-in subset walk, or the custom role's set against the caller's.
   */
  private async decideRole(
    tx: TenantQueryRunner,
    context: TenantContext,
    principal: Principal,
    input: HireInput,
  ): Promise<string> {
    const stored = typeof input.role === 'string' ? input.role : input.role.customRoleId;
    const capabilities = await capabilitiesOfStoredRole(tx, context, stored);
    if (typeof input.role !== 'string' && capabilities.size === 0) {
      throw validation([{ field: 'role', message: 'is not a role of this workspace' }]);
    }
    const principalRole: PrincipalRole =
      typeof input.role === 'string' ? input.role : customRoleKey(stored, capabilities);
    const decision = aiRoleDecision(principalRole, capabilities);
    if (!decision.allowed) {
      const admin = aiAdminCapabilitiesIn(capabilities);
      throw new ApiError(
        400,
        'validation_failed',
        'An AI employee can only be given a role without administration rights.',
        admin.length > 0
          ? admin.map((capability) => ({ field: 'role', message: capability }))
          : [{ field: 'role', message: 'must be member, guest or a custom role' }],
        `ai_employee:${decision.reason}`,
      );
    }
    if (typeof input.role === 'string') {
      requireMayGrantRole(principal, stored, context.organizationId, 'ai_employee.hire');
    } else if (exceedsCaller(capabilities, effectiveCapabilitySet(principal))) {
      throw new ApiError(
        403,
        'forbidden',
        'You can only give a role whose rights you hold yourself.',
        undefined,
        'ai_employee.hire:role_escalation',
      );
    }
    return stored;
  }

  /** A sponsor is an active person (kind human) of this workspace, never the Support role. */
  private async sponsorIsActivePerson(
    tx: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
  ): Promise<boolean> {
    const member = await this.options.repository.findMember(tx, context, membershipId);
    return (
      member !== null &&
      member.kind === 'human' &&
      member.status === 'active' &&
      !isPlatformSupportRole(member.role)
    );
  }

  private async find(
    runner: TenantQueryRunner,
    context: TenantContext,
    id: string,
  ): Promise<AiEmployeeRecord> {
    const row = await this.options.repository.findById(runner, context, id.toLowerCase());
    if (row === null) throw notFound('ai_employee:not_found');
    return row;
  }

  /**
   * Read, decide, write conditionally on `version`, audit — one transaction. A stale version is
   * 409 with no write (the caller re-reads); another workspace's id is 404.
   */
  private async change(
    context: TenantContext,
    id: string,
    version: number,
    at: Date,
    decide: (tx: TenantQueryRunner, current: AiEmployeeRecord) => Promise<AiEmployeeChange>,
  ): Promise<AiEmployeeView> {
    await this.options.database.transaction(context, async (tx) => {
      const current = await this.find(tx, context, id);
      if (current.version !== version) {
        throw conflict('ai_employee:stale_version', 'Someone changed this AI employee; reload it.');
      }
      const change = await decide(tx, current);
      const written = await this.options.repository.update(
        tx,
        context,
        current.id,
        version,
        change,
        at,
      );
      if (!written) {
        throw conflict('ai_employee:stale_version', 'Someone changed this AI employee; reload it.');
      }
    });
    const row = await this.options.database.read(context, (db) => this.find(db, context, id));
    return this.view(row, true);
  }
}

/**
 * The people-only door: a person's cookie session in this workspace. An API key or the connector
 * (`actorChannel` set), a client principal, or a service context is refused with 403.
 */
export function requirePersonSession(context: TenantContext, principal: Principal): void {
  if (
    context.actorChannel !== undefined ||
    context.principalKind !== 'internal' ||
    principal.kind !== 'internal'
  ) {
    throw new ApiError(
      403,
      'forbidden',
      'Only a person signed in to TManage can manage AI employees.',
      undefined,
      'ai_employee:person_session_only',
    );
  }
}

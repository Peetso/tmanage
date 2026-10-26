import { authorize, CLIENT_ROLES } from '@tmanage/domain';
import type { Audience, ClientRole, Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { AuditService } from '../audit/audit.service.js';
import { ProjectsRepository } from '../projects/projects.repository.js';
import {
  ClientMembershipNotFoundError,
  ClientMembershipsRepository,
  ClientMembershipTransitionError,
  ClientMembershipVersionConflictError,
} from './client-memberships.repository.js';
import {
  ClientOrganizationNotFoundError,
  ClientOrganizationsRepository,
  ClientOrganizationVersionConflictError,
} from './client-organizations.repository.js';
import { ProjectClientsRepository } from './project-clients.repository.js';
import type {
  ClientMembershipRow,
  ClientOrganizationRow,
  ProjectClientRow,
} from '../../common/database/schema.js';
import type { ClientMembershipStatus } from './client-memberships.repository.js';

/**
 * CLIENT-001 — client organizations, the people in them, and which projects they can see.
 *
 * The repositories landed with PROJ-001 and have been tested against a real server since; what
 * was missing was the layer that decides *who may call them* and writes down that they did.
 * This is that layer, and everything it does falls into one of three sentences:
 *
 * 1. A client organization is a boundary object. It has a name and nothing else that matters.
 * 2. A client membership is why a person outside the company can sign in and see anything.
 * 3. A `project_clients` row is why they can see a *particular project* — the only reason.
 *
 * ## Why every write here is audited and most work-item writes are not
 *
 * §12 lists role changes and publication among the events that must be recorded. Every method
 * below is one or the other: creating the boundary, letting somebody through it, changing what
 * they may do once inside, or handing them a project. Retitling a task is not in that set, and
 * `WorkItemsService` deliberately does not record it. The rule is the same in both files —
 * record what decides access — and it produces a short list there and a complete one here.
 *
 * ## Who may call any of this
 *
 * `client_member.manage` for the membership operations, `project.manage` for sharing, and
 * `org.manage` for the client organization itself. `12-PERMISSION-MATRIX` §2 gives client
 * roles `client_member.manage` too — "Invite client users: Within own client org/policy" —
 * and that is the harder half of this ticket rather than a footnote: a client admin may manage
 * **their own** client organization's members and nobody else's. The check is explicit and is
 * asserted from both sides.
 */

export interface ClientOrganizationView {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
}

export interface ClientMembershipView {
  readonly id: string;
  readonly clientOrganizationId: string;
  readonly userId: string;
  readonly role: string;
  readonly status: string;
  readonly expiresAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ProjectClientView {
  readonly id: string;
  readonly projectId: string;
  readonly clientOrganizationId: string;
  readonly createdAt: string;
}

/** One row of the New project client picker (PRJ-02). */
export interface ClientOrganizationOption {
  readonly id: string;
  readonly name: string;
}

/** The repository's page cap — a picker lists every active client in one read. */
const OPTIONS_LIMIT = 200;

/**
 * Explicit projections, never a serialised row — `25-AUTH-AND-TENANT-ISOLATION` §7.
 * `organization_id` is absent from all three: the caller already knows which organization they
 * asked about, and echoing a tenant identifier is how one reaches a client's bug report.
 */
function toOrganizationView(row: ClientOrganizationRow): ClientOrganizationView {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
  };
}

function toMembershipView(row: ClientMembershipRow): ClientMembershipView {
  return {
    id: row.id,
    clientOrganizationId: row.clientOrganizationId,
    userId: row.userId,
    role: row.role,
    status: row.status,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toShareView(row: ProjectClientRow): ProjectClientView {
  return {
    id: row.id,
    projectId: row.projectId,
    clientOrganizationId: row.clientOrganizationId,
    createdAt: row.createdAt.toISOString(),
  };
}

export interface ClientsServiceOptions {
  /**
   * `CLIENT_MEMBERSHIP_DEFAULT_EXPIRY_DAYS`, from `packages/config`.
   *
   * A bounded grant is the default and an open-ended one is a deliberate act, which is the
   * whole reason the column exists. The number lives in configuration rather than here so that
   * `49-PRICING`'s policy can change without a code change — and it is passed in rather than
   * read from the environment so a test can state it.
   */
  readonly defaultExpiryDays: number;
}

export class ClientsService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly options: ClientsServiceOptions,
    private readonly organizations: ClientOrganizationsRepository = new ClientOrganizationsRepository(),
    private readonly memberships: ClientMembershipsRepository = new ClientMembershipsRepository(),
    private readonly shares: ProjectClientsRepository = new ProjectClientsRepository(),
    private readonly projects: ProjectsRepository = new ProjectsRepository(),
    /** Optional for the reason `ProjectsService`'s is: a test can assert what was written. */
    private readonly audit?: AuditService,
  ) {}

  // ── Client organizations ──────────────────────────────────────────────────

  async listOrganizations(
    context: TenantContext,
    principal: Principal,
    options: { readonly includeArchived?: boolean } = {},
  ): Promise<readonly ClientOrganizationView[]> {
    this.requireCapability(principal, context, 'org.manage', 'client_organization.list');

    const rows = await this.database.read(context, (runner) =>
      this.organizations.list(runner, context, options),
    );
    return rows.map(toOrganizationView);
  }

  /**
   * BK1 / PRJ-02 — the New project client picker: active client companies, id and name only,
   * sorted by name.
   *
   * `project.create` rather than `org.manage`: whoever may create a project may choose its client
   * without being able to manage the client list itself, and the projection is the two fields a
   * picker needs and nothing more.
   */
  async listOrganizationOptions(
    context: TenantContext,
    principal: Principal,
  ): Promise<readonly ClientOrganizationOption[]> {
    this.requireCapability(principal, context, 'project.create', 'client_organization.options');

    const rows = await this.database.read(context, (runner) =>
      this.organizations.list(runner, context, { limit: OPTIONS_LIMIT }),
    );
    return rows
      .map((row) => ({ id: row.id, name: row.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async getOrganization(
    context: TenantContext,
    principal: Principal,
    clientOrganizationId: string,
  ): Promise<ClientOrganizationView> {
    this.requireCapability(principal, context, 'org.manage', 'client_organization.read');
    return toOrganizationView(await this.readOrganization(context, clientOrganizationId));
  }

  async createOrganization(
    context: TenantContext,
    principal: Principal,
    name: string,
  ): Promise<ClientOrganizationView> {
    this.requireCapability(principal, context, 'org.manage', 'client_organization.create');

    const row = await this.database.transaction(context, async (tx) => {
      const created = await this.organizations.create(tx, context, { name });
      await this.audit?.record(tx, context, {
        action: 'client_organization.created',
        objectId: created.id,
        result: 'allowed',
        metadata: {},
      });
      return created;
    });

    return toOrganizationView(row);
  }

  async updateOrganization(
    context: TenantContext,
    principal: Principal,
    clientOrganizationId: string,
    expectedUpdatedAt: Date,
    name: string,
  ): Promise<ClientOrganizationView> {
    this.requireCapability(principal, context, 'org.manage', 'client_organization.update');
    await this.readOrganization(context, clientOrganizationId);

    const row = await this.writing(() =>
      this.database.transaction(context, async (tx) => {
        const updated = await this.organizations.update(
          tx,
          context,
          clientOrganizationId,
          expectedUpdatedAt,
          { name },
        );
        await this.audit?.record(tx, context, {
          action: 'client_organization.updated',
          objectId: updated.id,
          result: 'allowed',
          metadata: {},
        });
        return updated;
      }),
    );

    return toOrganizationView(row);
  }

  /**
   * Archive a client organization.
   *
   * **This does not revoke anybody's access**, and the audit metadata says how many grants it
   * left behind rather than letting the archive read as an offboarding. Ending a relationship
   * is two acts: archive the organization, then offboard each membership. The repository's own
   * comment makes the same point; recording the count is what turns it from a comment into
   * something an investigation can see.
   */
  async archiveOrganization(
    context: TenantContext,
    principal: Principal,
    clientOrganizationId: string,
  ): Promise<ClientOrganizationView> {
    this.requireCapability(principal, context, 'org.manage', 'client_organization.archive');
    await this.readOrganization(context, clientOrganizationId);

    const row = await this.writing(() =>
      this.database.transaction(context, async (tx) => {
        const stillActive = await this.memberships.list(tx, context, {
          clientOrganizationId,
          statuses: ['active'],
        });
        const archived = await this.organizations.archive(tx, context, clientOrganizationId);
        await this.audit?.record(tx, context, {
          action: 'client_organization.archived',
          objectId: archived.id,
          result: 'allowed',
          metadata: {
            // Not a count of what was revoked. A count of what was not.
            active_memberships_remaining: String(stillActive.length),
          },
        });
        return archived;
      }),
    );

    return toOrganizationView(row);
  }

  // ── Client memberships ────────────────────────────────────────────────────

  async listMemberships(
    context: TenantContext,
    principal: Principal,
    options: {
      readonly clientOrganizationId?: string;
      readonly statuses?: readonly ClientMembershipStatus[];
      readonly includeExpired?: boolean;
    } = {},
  ): Promise<readonly ClientMembershipView[]> {
    const scope = this.membershipScope(principal, context, 'client_membership.list');

    // A client admin may list their own client organization's members and nobody else's. A
    // request naming another client organization is not filtered down to nothing — it is
    // refused, because a silent empty list looks like "there is nobody there" and invites the
    // caller to conclude something about a boundary they cannot see.
    if (scope !== null && options.clientOrganizationId && options.clientOrganizationId !== scope) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound);
    }

    const rows = await this.database.read(context, (runner) =>
      this.memberships.list(runner, context, {
        ...options,
        ...(scope === null ? {} : { clientOrganizationId: scope }),
      }),
    );
    return rows.map(toMembershipView);
  }

  /**
   * Invite somebody into a client organization.
   *
   * The expiry is the policy's unless the caller states one. `expiresAt: null` is accepted and
   * means open-ended — some client relationships genuinely are — but it has to be asked for by
   * name rather than obtained by omitting a field.
   */
  async invite(
    context: TenantContext,
    principal: Principal,
    input: {
      readonly clientOrganizationId: string;
      readonly userId: string;
      readonly role: ClientRole;
      /** Omitted: the policy default. `null`: open-ended, deliberately. */
      readonly expiresAt?: Date | null;
    },
  ): Promise<ClientMembershipView> {
    this.requireOwnClientOrganization(
      principal,
      context,
      input.clientOrganizationId,
      'client_membership.invite',
    );
    // A raw `userId` invite is staff-only (audit F27). A client admin invites their own people
    // through the email-bound `POST portal/client-members` flow, where the invitee must accept; with
    // a raw id here they could attach any user — internal staff included — to their organization.
    // After the scope check, so a sibling client organization's id stays the same 404 as before.
    this.refuseClientPrincipal(principal, 'client_membership.invite');
    await this.readOrganization(context, input.clientOrganizationId);
    await this.refuseInternalMember(context, input.userId);

    const expiresAt =
      input.expiresAt === undefined ? this.defaultExpiry(new Date()) : input.expiresAt;

    const row = await this.writing(() =>
      this.database.transaction(context, async (tx) => {
        const invited = await this.memberships.invite(tx, context, {
          clientOrganizationId: input.clientOrganizationId,
          userId: input.userId,
          role: input.role,
          expiresAt,
        });
        await this.audit?.record(tx, context, {
          action: 'client_membership.invited',
          objectId: invited.id,
          result: 'allowed',
          metadata: {
            client_organization_id: invited.clientOrganizationId,
            role: invited.role,
            // Whether the grant is bounded, not when it ends. The date is on the row.
            bounded: expiresAt !== null,
          },
        });
        return invited;
      }),
    );

    return toMembershipView(row);
  }

  async changeRole(
    context: TenantContext,
    principal: Principal,
    clientMembershipId: string,
    expectedUpdatedAt: Date,
    role: ClientRole,
  ): Promise<ClientMembershipView> {
    const before = await this.readMembershipForWrite(
      context,
      principal,
      clientMembershipId,
      'client_membership.change_role',
    );

    const row = await this.writing(() =>
      this.database.transaction(context, async (tx) => {
        const changed = await this.memberships.changeRole(
          tx,
          context,
          clientMembershipId,
          expectedUpdatedAt,
          role,
        );
        await this.audit?.record(tx, context, {
          action: 'client_membership.role_changed',
          objectId: changed.id,
          result: 'allowed',
          metadata: {
            client_organization_id: changed.clientOrganizationId,
            role_before: before.role,
            role_after: changed.role,
          },
        });
        return changed;
      }),
    );

    return toMembershipView(row);
  }

  async setExpiry(
    context: TenantContext,
    principal: Principal,
    clientMembershipId: string,
    expectedUpdatedAt: Date,
    expiresAt: Date | null,
  ): Promise<ClientMembershipView> {
    const before = await this.readMembershipForWrite(
      context,
      principal,
      clientMembershipId,
      'client_membership.set_expiry',
    );
    // Wave 10 R5 (F27 variant 2): an active row whose expiry has passed is dead; extending it (or
    // making it open-ended) makes it live again. If that person is staff here now, the revived dual
    // membership would collide with their internal one, so the same refusal as changeStatus applies.
    if (before.status === 'active' && (expiresAt === null || expiresAt.getTime() > Date.now())) {
      await this.refuseInternalMember(context, before.userId);
    }

    const row = await this.writing(() =>
      this.database.transaction(context, async (tx) => {
        const changed = await this.memberships.setExpiry(
          tx,
          context,
          clientMembershipId,
          expectedUpdatedAt,
          expiresAt,
        );
        await this.audit?.record(tx, context, {
          action: 'client_membership.expiry_changed',
          objectId: changed.id,
          result: 'allowed',
          metadata: {
            client_organization_id: changed.clientOrganizationId,
            bounded_before: before.expiresAt !== null,
            bounded_after: expiresAt !== null,
          },
        });
        return changed;
      }),
    );

    return toMembershipView(row);
  }

  async changeStatus(
    context: TenantContext,
    principal: Principal,
    clientMembershipId: string,
    expectedUpdatedAt: Date,
    to: ClientMembershipStatus,
  ): Promise<ClientMembershipView> {
    const before = await this.readMembershipForWrite(
      context,
      principal,
      clientMembershipId,
      'client_membership.change_status',
    );
    if (to === 'active') {
      // An unaccepted invitation is activated only by the invitee accepting it or by staff, never by
      // a client admin (audit F27); a client admin may still reinstate a suspended colleague.
      if (before.status === 'invited') {
        this.refuseClientPrincipal(principal, 'client_membership.change_status');
      }
      // Never make a client membership live for someone who is already staff here: the dual
      // membership would lock them out of the whole tenant.
      await this.refuseInternalMember(context, before.userId);
    }

    const row = await this.writing(() =>
      this.database.transaction(context, async (tx) => {
        const changed = await this.memberships.transitionStatus(
          tx,
          context,
          clientMembershipId,
          expectedUpdatedAt,
          to,
        );
        await this.audit?.record(tx, context, {
          action: 'client_membership.status_changed',
          objectId: changed.id,
          result: 'allowed',
          metadata: {
            client_organization_id: changed.clientOrganizationId,
            status_before: before.status,
            status_after: changed.status,
          },
        });
        return changed;
      }),
    );

    return toMembershipView(row);
  }

  // ── Project sharing ───────────────────────────────────────────────────────

  async listShares(
    context: TenantContext,
    principal: Principal,
    projectId: string,
  ): Promise<readonly ProjectClientView[]> {
    this.requireProjectManage(principal, context, projectId, 'project_client.list');
    await this.readProject(context, projectId);

    const rows = await this.database.read(context, (runner) =>
      this.shares.list(runner, context, { projectId }),
    );
    return rows.map(toShareView);
  }

  /**
   * Share a project with a client organization.
   *
   * Both sides are read first. Not because the database would let a foreign one through — both
   * composite foreign keys refuse that — but because a foreign key violation surfaces as a 500,
   * and a caller who named something that is not in this tenant should get the 404 that every
   * other "no relation to this" produces.
   */
  async share(
    context: TenantContext,
    principal: Principal,
    projectId: string,
    clientOrganizationId: string,
  ): Promise<ProjectClientView> {
    this.requireProjectManage(principal, context, projectId, 'project_client.link');
    await this.readProject(context, projectId);
    const clientOrganization = await this.readOrganization(context, clientOrganizationId);

    // Sharing a project with an archived client is refused rather than allowed and audited.
    // The archive is the record that the relationship ended; handing it a new project would
    // make that record false.
    if (clientOrganization.archivedAt !== null) {
      throw new ApiError(422, 'validation_failed', 'That client organization is archived', [
        { field: 'clientOrganizationId', message: 'is archived' },
      ]);
    }

    const row = await this.writing(() =>
      this.database.transaction(context, async (tx) => {
        const shared = await this.shares.share(tx, context, { projectId, clientOrganizationId });
        await this.audit?.record(tx, context, {
          action: 'project.client_linked',
          objectId: shared.id,
          result: 'allowed',
          metadata: {
            project_id: shared.projectId,
            client_organization_id: shared.clientOrganizationId,
          },
        });
        return shared;
      }),
    );

    return toShareView(row);
  }

  /**
   * Withdraw a share.
   *
   * Recorded even when there was nothing to withdraw. "Somebody tried to revoke access that
   * was not there" is a fact worth having in the trail — it is what a mistaken revoke looks
   * like, and an investigation that saw nothing would conclude the request never happened.
   */
  async unshare(
    context: TenantContext,
    principal: Principal,
    projectId: string,
    clientOrganizationId: string,
  ): Promise<void> {
    this.requireProjectManage(principal, context, projectId, 'project_client.unlink');
    await this.readProject(context, projectId);

    await this.database.transaction(context, async (tx) => {
      const existing = await this.shares.find(tx, context, { projectId, clientOrganizationId });
      const removed = await this.shares.unshare(tx, context, { projectId, clientOrganizationId });
      await this.audit?.record(tx, context, {
        action: 'project.client_unlinked',
        objectId: existing?.id ?? projectId,
        result: 'allowed',
        metadata: {
          project_id: projectId,
          client_organization_id: clientOrganizationId,
          was_shared: removed,
        },
      });
    });
  }

  /**
   * BK1 / PRJ-02 — set a project's client, as the New project and Edit project forms mean it:
   * one client or none.
   *
   * Replaces every existing share in one transaction, so changing the client is never a moment
   * where the project is shared with both or with neither. Each removal and the new link are
   * audited exactly as `unshare` and `share` audit them; re-setting the current client writes
   * nothing.
   */
  async setProjectClient(
    context: TenantContext,
    principal: Principal,
    projectId: string,
    clientOrganizationId: string | null,
  ): Promise<readonly ProjectClientView[]> {
    this.requireProjectManage(principal, context, projectId, 'project_client.set');
    await this.readProject(context, projectId);
    if (clientOrganizationId !== null) {
      const clientOrganization = await this.readOrganization(context, clientOrganizationId);
      if (clientOrganization.archivedAt !== null) {
        throw new ApiError(422, 'validation_failed', 'That client organization is archived', [
          { field: 'clientOrganizationId', message: 'is archived' },
        ]);
      }
    }

    const rows = await this.writing(() =>
      this.database.transaction(context, async (tx) => {
        const existing = await this.shares.list(tx, context, { projectId, limit: OPTIONS_LIMIT });
        for (const share of existing) {
          if (share.clientOrganizationId === clientOrganizationId) continue;
          await this.shares.unshare(tx, context, {
            projectId,
            clientOrganizationId: share.clientOrganizationId,
          });
          await this.audit?.record(tx, context, {
            action: 'project.client_unlinked',
            objectId: share.id,
            result: 'allowed',
            metadata: {
              project_id: projectId,
              client_organization_id: share.clientOrganizationId,
              was_shared: true,
            },
          });
        }
        if (clientOrganizationId === null) return [];

        const kept = existing.find((share) => share.clientOrganizationId === clientOrganizationId);
        if (kept) return [kept];
        const shared = await this.shares.share(tx, context, { projectId, clientOrganizationId });
        await this.audit?.record(tx, context, {
          action: 'project.client_linked',
          objectId: shared.id,
          result: 'allowed',
          metadata: {
            project_id: shared.projectId,
            client_organization_id: shared.clientOrganizationId,
          },
        });
        return [shared];
      }),
    );

    return rows.map(toShareView);
  }

  // ── The parts every method above leans on ─────────────────────────────────

  /**
   * The policy default expiry, as a date.
   *
   * Computed from a caller-supplied "now" so the arithmetic is testable without waiting, and
   * in whole days because that is the unit `49-PRICING` states the policy in.
   */
  private defaultExpiry(now: Date): Date {
    const expiry = new Date(now.getTime());
    expiry.setUTCDate(expiry.getUTCDate() + this.options.defaultExpiryDays);
    return expiry;
  }

  /**
   * Translate the repositories' write failures.
   *
   * A stale token is a **409**, and a caller who saw a 500 would retry — which is the lost
   * update the token exists to prevent. An illegal status move is a **422** naming what was
   * attempted, because the caller can fix that by asking for a legal one.
   */
  private async writing<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (
        error instanceof ClientOrganizationVersionConflictError ||
        error instanceof ClientMembershipVersionConflictError
      ) {
        throw new ApiError(409, 'conflict', MESSAGES.conflict, [
          { field: 'updatedAt', message: 'the record changed since you read it' },
        ]);
      }
      if (error instanceof ClientMembershipTransitionError) {
        throw new ApiError(422, 'validation_failed', 'That status change is not allowed', [
          { field: 'status', message: error.message },
        ]);
      }
      if (
        error instanceof ClientOrganizationNotFoundError ||
        error instanceof ClientMembershipNotFoundError
      ) {
        throw new ApiError(404, 'not_found', MESSAGES.notFound);
      }
      throw error;
    }
  }

  private async readOrganization(
    context: TenantContext,
    clientOrganizationId: string,
  ): Promise<ClientOrganizationRow> {
    const row = await this.database.read(context, (runner) =>
      this.organizations.findById(runner, context, clientOrganizationId),
    );
    if (!row) throw new ApiError(404, 'not_found', MESSAGES.notFound);
    return row;
  }

  private async readProject(context: TenantContext, projectId: string) {
    const row = await this.database.read(context, (runner) =>
      this.projects.findById(runner, context, projectId),
    );
    if (!row || row.archivedAt !== null) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound);
    }
    return row;
  }

  private async readMembershipForWrite(
    context: TenantContext,
    principal: Principal,
    clientMembershipId: string,
    action: string,
  ): Promise<ClientMembershipRow> {
    const row = await this.database.read(context, (runner) =>
      this.memberships.findById(runner, context, clientMembershipId),
    );
    if (!row) throw new ApiError(404, 'not_found', MESSAGES.notFound);
    this.requireOwnClientOrganization(principal, context, row.clientOrganizationId, action);
    return row;
  }

  /**
   * Which client organization this principal may act on, or `null` for "any in this tenant".
   *
   * An internal principal with `client_member.manage` manages every client of the tenant. A
   * client principal manages exactly their own, which is the `12-PERMISSION-MATRIX` §2 clause
   * "Invite client users: Within own client org/policy" — and the narrower half is the one
   * worth writing carefully, because getting it wrong hands one client the other's people.
   */
  private membershipScope(
    principal: Principal,
    context: TenantContext,
    action: string,
  ): string | null {
    // The audience depends on who is asking, and getting this wrong is the trap
    // `CapabilityGuard` documents at the top of its own file: `authorize()` denies **any**
    // client principal an `internal` resource, so a synthetic internal context here would
    // 403 every client admin before the scope rule below ever ran. A client managing their
    // own client organization's people is reading a client-facing resource, and it is
    // labelled as one.
    this.requireCapability(principal, context, 'client_member.manage', action, {
      audience: principal.kind === 'client' ? 'client_visible' : 'internal',
      clientOrganizationId: principal.clientOrganizationId,
    });
    if (principal.kind !== 'client') return null;

    const own = principal.clientOrganizationId;
    if (own === null) {
      // A client principal with no client organization has no scope at all. The resolver does
      // not produce one, and this is the second place that says so.
      throw new ApiError(404, 'not_found', MESSAGES.notFound);
    }
    return own;
  }

  /** A staff-only membership write: any client principal is a 403 (audit F27). */
  private refuseClientPrincipal(principal: Principal, action: string): void {
    if (principal.kind === 'client' || isClientRole(principal.role)) {
      throw new ApiError(
        403,
        'forbidden',
        MESSAGES.forbidden,
        undefined,
        `${action}:client_principal_staff_only`,
      );
    }
  }

  /**
   * A user with an active internal membership in this tenant may not hold a live client membership
   * here as well (audit F27). The refusal is a neutral 404 and nothing is written, so the caller
   * learns nothing about who is staff.
   */
  private async refuseInternalMember(context: TenantContext, userId: string): Promise<void> {
    const isStaff = await this.database.read(context, (runner) =>
      this.memberships.userHasActiveInternalMembership(runner, context, userId),
    );
    if (isStaff) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'user_is_internal_member');
    }
  }

  private requireOwnClientOrganization(
    principal: Principal,
    context: TenantContext,
    clientOrganizationId: string,
    action: string,
  ): void {
    const scope = this.membershipScope(principal, context, action);
    if (scope !== null && scope !== clientOrganizationId) {
      // 404, not 403. A client admin probing for another client's membership ids must not
      // learn which of them exist.
      throw new ApiError(404, 'not_found', MESSAGES.notFound);
    }
  }

  private requireProjectManage(
    principal: Principal,
    context: TenantContext,
    projectId: string,
    action: string,
  ): void {
    const verdict = authorize({
      principal,
      capability: 'project.manage',
      resource: {
        organizationId: context.organizationId,
        projectId,
        audience: 'internal',
        lifecycle: 'active',
      },
    });
    if (!verdict.allowed) {
      throw new ApiError(
        403,
        'forbidden',
        MESSAGES.forbidden,
        undefined,
        `${action}:${verdict.code}`,
      );
    }
  }

  private requireCapability(
    principal: Principal,
    context: TenantContext,
    capability: Parameters<typeof authorize>[0]['capability'],
    action: string,
    facing: {
      readonly audience: Audience;
      readonly clientOrganizationId?: string | null;
    } = { audience: 'internal' },
  ): void {
    const verdict = authorize({
      principal,
      capability,
      resource: {
        organizationId: context.organizationId,
        // Null, deliberately. `ResourceContext.projectId` is "null for org-level resources
        // such as organization settings", and a client organization is exactly that. Naming
        // a project here would let a project relation stand in for an organization-wide
        // capability the caller does not hold.
        projectId: null,
        audience: facing.audience,
        ...(facing.clientOrganizationId === undefined
          ? {}
          : { clientOrganizationId: facing.clientOrganizationId }),
        lifecycle: 'active',
      },
    });
    if (!verdict.allowed) {
      throw new ApiError(
        403,
        'forbidden',
        MESSAGES.forbidden,
        undefined,
        `${action}:${verdict.code}`,
      );
    }
  }
}

/** Exported so the controller can validate a role without restating the list. */
export function isClientRole(value: string): value is ClientRole {
  return (CLIENT_ROLES as readonly string[]).includes(value);
}

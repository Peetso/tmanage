import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import {
  ACCESS_ELSEWHERE_REASON,
  ACCESS_ELSEWHERE_TABLES,
  AdminSessionsRepository,
} from './admin-sessions.repository.js';
import type { AdminSessionRow, OrgMemberRow } from './admin-sessions.repository.js';

/**
 * Admin session visibility + revocation (x223, Administration module 18) — the orchestration
 * half over {@link AdminSessionsRepository}. Its whole job is to bridge the two database paths
 * the repository documents: the membership roster is a tenant fact, a session row is identity
 * state, and this service reads each on its own runner and joins them in memory.
 *
 * The tenant scope of the feature is that join. Every session it lists, and the one session it
 * revokes, belongs to a `user_id` that a tenant-scoped membership read has already proved is a
 * member of the caller's organization. A session whose owner is not a member is invisible to
 * the list and answers 404 to a revoke — the controller never distinguishes it from an id that
 * does not exist, so one organization's admin cannot probe another's sessions.
 *
 * ## Wave 9 S8 (audit F42): single-organization members only, and never the owner from below
 *
 * A session row is global: it signs the person into every organization they belong to. So an admin
 * here may list or end the sessions only of members whose ONLY access is this organization — a
 * member who also works elsewhere is invisible to the list (no device or activity metadata leaves)
 * and a revoke of their session is the same 404 as an unknown id. And the owner is exempt from the
 * actions of others: only an owner may see or end an owner's sessions (a lower role gets 403).
 */

/** The global tables the session half reaches — enforced by `TenantDatabase.identity*`. */
const SESSION_TABLES = ['sessions'] as const;

/** Why an admin revocation closed a session. Distinct from a self sign-out or a reuse finding. */
const ADMIN_REVOCATION_REASON = 'admin_revoked';

/**
 * One row of the admin session list, ready for the wire. Metadata only — the member it belongs
 * to, when the session began, when it was last active, and the device label — and never any
 * token or refresh material.
 */
export interface AdminSessionListEntry {
  readonly sessionId: string;
  readonly membershipId: string;
  readonly memberName: string;
  /** ISO-8601. When the session was established. */
  readonly createdAt: string;
  /** ISO-8601. Last activity — the last rotation, or the creation time if never rotated. */
  readonly lastSeenAt: string;
  /** The user-agent string captured at sign-in, or `null` if none was sent. */
  readonly deviceLabel: string | null;
}

export class AdminSessionsService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly repository: AdminSessionsRepository = new AdminSessionsRepository(),
  ) {}

  /**
   * List the live sessions of every active member of the caller's organization. The roster is
   * read tenant-scoped; the sessions are read on the identity path for exactly those members'
   * user ids; the two are joined here. A member with no live session simply contributes no row.
   */
  async listOrgSessions(
    context: TenantContext,
    callerRole: string,
  ): Promise<readonly AdminSessionListEntry[]> {
    const members = await this.manageableMembers(context, callerRole);
    if (members.length === 0) return [];

    const byUserId = new Map<string, OrgMemberRow>(members.map((m) => [m.userId, m]));
    const rows = await this.database.identityRead(
      { correlationId: context.correlationId, tables: [...SESSION_TABLES] },
      (runner) => this.repository.listActiveForUsers(runner, [...byUserId.keys()]),
    );

    const entries: AdminSessionListEntry[] = [];
    for (const row of rows) {
      const member = byUserId.get(row.userId);
      if (!member) continue; // Defensive: a member offboarded between the two reads.
      entries.push(toEntry(row, member));
    }
    return entries;
  }

  /**
   * Resolve a session id to the membership of its owner **within the caller's organization**,
   * or `null` if the id is unknown or its owner is not a member here. This is the resolve step
   * the controller runs BEFORE authorizing, so a cross-tenant or unknown id is a 404 with no
   * write and never leaks another organization's session through a 403.
   */
  async resolveMemberSession(
    context: TenantContext,
    sessionId: string,
  ): Promise<{ readonly membershipId: string; readonly role: string } | null> {
    const ownerUserId = await this.database.identityRead(
      { correlationId: context.correlationId, tables: [...SESSION_TABLES] },
      (runner) => this.repository.findSessionUserId(runner, sessionId),
    );
    if (!ownerUserId) return null;

    const members = await this.database.read(context, (runner) =>
      this.repository.listOrgMembers(runner, context),
    );
    const member = members.find((m) => m.userId === ownerUserId);
    if (!member) return null;
    // F42: a person who also acts in another organization is not this organization's to sign out.
    const elsewhere = await this.usersWithAccessElsewhere(context, [member.userId]);
    if (elsewhere.has(member.userId)) return null;
    return { membershipId: member.membershipId, role: member.role };
  }

  /**
   * F42: the members whose sessions this caller may see — single-organization members only, and an
   * owner's sessions only for an owner caller.
   */
  private async manageableMembers(
    context: TenantContext,
    callerRole: string,
  ): Promise<readonly OrgMemberRow[]> {
    const members = await this.database.read(context, (runner) =>
      this.repository.listOrgMembers(runner, context),
    );
    if (members.length === 0) return [];
    const elsewhere = await this.usersWithAccessElsewhere(
      context,
      members.map((m) => m.userId),
    );
    return members.filter(
      (m) => !elsewhere.has(m.userId) && (m.role !== 'owner' || callerRole === 'owner'),
    );
  }

  private async usersWithAccessElsewhere(
    context: TenantContext,
    userIds: readonly string[],
  ): Promise<ReadonlySet<string>> {
    return this.database.bootstrapRead(
      {
        correlationId: context.correlationId,
        reason: ACCESS_ELSEWHERE_REASON,
        tables: [...ACCESS_ELSEWHERE_TABLES],
      },
      (runner) =>
        this.repository.listUsersWithAccessElsewhere(runner, context.organizationId, userIds),
    );
  }

  /**
   * Soft-close one session. Idempotent — an already-revoked session stays revoked and this is a
   * no-op, so the caller can safely retry. Never a hard delete. The caller must have resolved
   * the session to a member of this organization first; this method trusts that gate.
   */
  async revokeSession(context: TenantContext, sessionId: string): Promise<void> {
    await this.database.identityTransaction(
      { correlationId: context.correlationId, tables: [...SESSION_TABLES] },
      (runner) => this.repository.revoke(runner, sessionId, ADMIN_REVOCATION_REASON),
    );
  }
}

/** Project one live session row plus its member to the wire entry — `Date`s as ISO strings. */
function toEntry(row: AdminSessionRow, member: OrgMemberRow): AdminSessionListEntry {
  return {
    sessionId: row.id,
    membershipId: member.membershipId,
    memberName: member.displayName,
    createdAt: row.createdAt.toISOString(),
    lastSeenAt: (row.rotatedAt ?? row.createdAt).toISOString(),
    deviceLabel: row.userAgent,
  };
}

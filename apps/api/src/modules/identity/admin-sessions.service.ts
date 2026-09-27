import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { AdminSessionsRepository } from './admin-sessions.repository.js';
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
  async listOrgSessions(context: TenantContext): Promise<readonly AdminSessionListEntry[]> {
    const members = await this.database.read(context, (runner) =>
      this.repository.listOrgMembers(runner, context),
    );
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
  ): Promise<{ readonly membershipId: string } | null> {
    const ownerUserId = await this.database.identityRead(
      { correlationId: context.correlationId, tables: [...SESSION_TABLES] },
      (runner) => this.repository.findSessionUserId(runner, sessionId),
    );
    if (!ownerUserId) return null;

    const members = await this.database.read(context, (runner) =>
      this.repository.listOrgMembers(runner, context),
    );
    const member = members.find((m) => m.userId === ownerUserId);
    return member ? { membershipId: member.membershipId } : null;
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

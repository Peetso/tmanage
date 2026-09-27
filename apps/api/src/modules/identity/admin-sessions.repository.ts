import { and, asc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { memberships, sessions, users } from '../../common/database/schema.js';
import type {
  IdentityQueryRunner,
  TenantContext,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';

/**
 * Admin session visibility + revocation storage (x223, Administration module 18).
 *
 * The audit found ID-001's session storage built (refresh/rotation, the person's own device
 * list) with **no admin surface**: an owner could not see, let alone end, the sessions of the
 * people in their organization. This repository is that surface's persistence half, and it is
 * unusual for a good reason — it spans the two database paths, because the fact it reports on
 * (who is a member of this organization) and the fact it acts on (a session row) live on
 * opposite sides of ADR-0001's identity boundary.
 *
 * ## Two runners, never one statement
 *
 * `sessions` and `users` carry no `organization_id`: a person is one account holding
 * memberships in many organizations, so their sessions cannot be forked per tenant (they are
 * in `NON_TENANT_TABLES`). `memberships` is the tenant table that ties a `user_id` to an
 * `organization_id`. So there is no single query that both scopes to the caller's tenant and
 * reads a session — a join across the boundary is exactly what the guard forbids.
 *
 * The service therefore runs {@link listOrgMembers} on the **tenant** runner (scoped by
 * `organization_id`, the membership roster is the tenant fact) and the session methods on the
 * **identity** runner (no tenant predicate, because the table has no tenant key), and joins the
 * two in memory. A session is only ever surfaced or revoked for a `user_id` the tenant read
 * already proved is a member of the caller's organization — that in-memory gate is this
 * feature's tenant scope, and it is why a cross-tenant session id is a 404, not a 403.
 */

/** One active member of the caller's organization — the tenant half, from `memberships`. */
export interface OrgMemberRow {
  readonly membershipId: string;
  readonly userId: string;
  readonly displayName: string;
}

/**
 * One active session — the identity half, from `sessions`. Deliberately projects **no**
 * `refresh_token_hash` (or any other credential material): an admin list is metadata only.
 */
export interface AdminSessionRow {
  readonly id: string;
  readonly userId: string;
  readonly userAgent: string | null;
  readonly createdAt: Date;
  readonly rotatedAt: Date | null;
  readonly expiresAt: Date;
}

export class AdminSessionsRepository {
  /** The active membership roster for the caller's organization (tenant runner, scoped). */
  async listOrgMembers(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<readonly OrgMemberRow[]> {
    return tenantDrizzle(runner)
      .select({
        membershipId: memberships.id,
        userId: memberships.userId,
        displayName: users.displayName,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(
        and(
          eq(memberships.organizationId, context.organizationId),
          eq(memberships.status, 'active'),
        ),
      )
      .orderBy(asc(memberships.id));
  }

  /**
   * Live sessions for a set of member user ids (identity runner). Live = not revoked and not
   * past its absolute deadline, both decided by the **server** clock. No credential material.
   * An empty `userIds` returns nothing without touching the database.
   */
  async listActiveForUsers(
    runner: IdentityQueryRunner,
    userIds: readonly string[],
  ): Promise<readonly AdminSessionRow[]> {
    if (userIds.length === 0) return [];
    return tenantDrizzle(runner)
      .select({
        id: sessions.id,
        userId: sessions.userId,
        userAgent: sessions.userAgent,
        createdAt: sessions.createdAt,
        rotatedAt: sessions.rotatedAt,
        expiresAt: sessions.expiresAt,
      })
      .from(sessions)
      .where(
        and(
          inArray(sessions.userId, [...userIds]),
          isNull(sessions.revokedAt),
          gt(sessions.expiresAt, sql`now(3)`),
        ),
      )
      .orderBy(asc(sessions.userId), asc(sessions.id));
  }

  /**
   * The `user_id` of one session, whatever state it is in, or `null` if no such row exists
   * (identity runner). This is the resolve step the revoke path runs BEFORE authorizing: the
   * id is looked up first, its owner checked against the caller's membership roster, and only a
   * member's session is ever acted on — so an unknown or cross-tenant id is indistinguishable.
   */
  async findSessionUserId(runner: IdentityQueryRunner, sessionId: string): Promise<string | null> {
    const rows = await tenantDrizzle(runner)
      .select({ userId: sessions.userId })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);
    return rows[0]?.userId ?? null;
  }

  /**
   * Soft-close one session (identity runner). Idempotent by construction: `revoked_at IS NULL`
   * in the predicate means a second call changes nothing and leaves the first reason in place,
   * so re-revoking an already-closed session is a no-op. Never a hard delete — a session id is
   * what the audit trail refers to, and a deleted row makes an audit entry unreadable.
   */
  async revoke(runner: IdentityQueryRunner, sessionId: string, reason: string): Promise<void> {
    await tenantDrizzle(runner)
      .update(sessions)
      .set({ revokedAt: sql`current_timestamp(3)`, revokedReason: reason })
      .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)));
  }
}

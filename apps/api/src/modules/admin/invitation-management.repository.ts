import { and, asc, eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { invitationPendingKeys, invitations, users } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * Admin pending-invitation management (Administration module 18, x328) — the data half. It reads and
 * revokes over the **existing** `invitations` table (TEN-003, `0005_invitations.sql`); it defines no
 * table, so there is no migration and no new registration. It is a separate file from the tenancy
 * `InvitationsRepository` so the administration surface stays disjoint from the invitation-issuance
 * slices.
 *
 * ## Every query is tenant-scoped, and no secret is ever selected
 *
 * The list and the single-row resolve both carry `organization_id = context.organizationId`, so
 * another studio's invitations are never read; the revoke stamps the same predicate, so a row in
 * another tenant is never written. The `token_hash` column — the one secret on the table — is never
 * in a select list here: the pending list returns metadata only (email, role, inviter, expiry), which
 * is the whole of what x328's screen shows.
 */

/** One pending invitation as the admin screen reads it — metadata only, never the token hash. */
export interface PendingInvitationRow {
  readonly id: string;
  readonly email: string;
  readonly role: string;
  readonly invitedByUserId: string;
  readonly invitedByName: string;
  readonly invitedByEmail: string;
  readonly expiresAt: Date;
  readonly createdAt: string;
}

/** The status of one invitation the acting tenant owns — the revoke transition reads it. */
export interface InvitationStatusRow {
  readonly id: string;
  readonly status: 'pending' | 'accepted' | 'expired' | 'revoked';
}

export class InvitationManagementRepository {
  /**
   * Every `pending` invitation the acting tenant owns, oldest first, joined to the inviter's name and
   * email. A pending row whose `expires_at` has already passed is still returned — the caller marks it
   * with an expired chip rather than hiding it. `users` is joined by id without a tenant predicate
   * because it is a `NON_TENANT_TABLES` table (the guard has nothing to enforce on it), exactly as the
   * tenancy invitation preview joins it.
   */
  async listPending(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<readonly PendingInvitationRow[]> {
    const rows = await tenantDrizzle(runner)
      .select({
        id: invitations.id,
        email: invitations.email,
        role: invitations.role,
        invitedByUserId: invitations.invitedByUserId,
        invitedByName: users.displayName,
        invitedByEmail: users.email,
        expiresAt: invitations.expiresAt,
        createdAt: invitations.createdAt,
      })
      .from(invitations)
      .innerJoin(users, eq(users.id, invitations.invitedByUserId))
      .where(
        and(
          eq(invitations.organizationId, context.organizationId),
          eq(invitations.status, 'pending'),
        ),
      )
      .orderBy(asc(invitations.createdAt), asc(invitations.id));

    return rows.map((row) => ({
      id: row.id,
      email: row.email,
      role: row.role,
      invitedByUserId: row.invitedByUserId,
      invitedByName: row.invitedByName,
      invitedByEmail: row.invitedByEmail,
      expiresAt: row.expiresAt,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  /**
   * The status of one invitation this tenant owns, or `undefined`. The resolve-by-(tenant,id) step the
   * revoke runs BEFORE authorize (Known trap): a context naming an id not in this tenant returns
   * `undefined`, which the caller turns into a 404 with no write — indistinguishable from "no such
   * invitation", which is the point.
   */
  async findStatus(
    runner: TenantQueryRunner,
    context: TenantContext,
    invitationId: string,
  ): Promise<InvitationStatusRow | undefined> {
    const rows = await tenantDrizzle(runner)
      .select({ id: invitations.id, status: invitations.status })
      .from(invitations)
      .where(
        and(
          eq(invitations.organizationId, context.organizationId),
          eq(invitations.id, invitationId),
        ),
      )
      .limit(1);
    return rows[0];
  }

  /**
   * Move one pending invitation to `revoked`, tenant-scoped. Returns the number of rows affected: the
   * `status = 'pending'` predicate makes the write happen exactly once, so a row that has already left
   * `pending` (raced, or already revoked) affects zero rows and the caller decides the outcome.
   */
  async revokePending(
    runner: TenantQueryRunner,
    context: TenantContext,
    invitationId: string,
  ): Promise<number> {
    const result = await tenantDrizzle(runner)
      .update(invitations)
      .set({
        status: 'revoked',
        revokedAt: sql`current_timestamp(3)`,
        updatedAt: sql`current_timestamp(3)`,
      })
      .where(
        and(
          eq(invitations.organizationId, context.organizationId),
          eq(invitations.id, invitationId),
          eq(invitations.status, 'pending'),
        ),
      );
    // B11 (0319): a revoked invitation no longer holds its address, so it can be invited again.
    if (result[0].affectedRows > 0) {
      await tenantDrizzle(runner)
        .delete(invitationPendingKeys)
        .where(
          and(
            eq(invitationPendingKeys.organizationId, context.organizationId),
            eq(invitationPendingKeys.invitationId, invitationId),
          ),
        );
    }
    return result[0].affectedRows;
  }
}

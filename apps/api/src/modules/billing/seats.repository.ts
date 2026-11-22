import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { billingSeats, memberships } from '../../common/database/schema.js';
import type { BillingSeatRow, MembershipRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * Billing seats — x178's storage half (Billing module 19).
 *
 * Follows the other tenant repositories: {@link TenantContext} is the scoping parameter, no
 * `organizationId` on any input (it comes from the context), and every read and write is bound to
 * `(organization_id, …)` so a caller in the wrong tenant sees nothing rather than a leak. The
 * repository holds no policy — the service decides who may act — and the composite foreign key of
 * migration 0075 is what makes a cross-tenant `membership_id` a non-existent pair.
 */

/** The largest active-seat roster a single read returns; mirrors the bounded reads elsewhere. */
export const MAX_SEATS_PAGE = 500;

export class BillingSeatsRepository {
  /**
   * The membership a seat would be assigned to, tenant-scoped; `null` if it is absent or belongs to
   * another tenant. Resolving it here is what turns a cross-tenant `membership_id` into a 404 in the
   * service, before any write, rather than a foreign-key 500.
   *
   * 60-09: an AI employee never takes a seat, so its membership answers `null` here too.
   */
  async findMembership(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
  ): Promise<MembershipRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(memberships)
      .where(
        and(
          eq(memberships.organizationId, context.organizationId),
          eq(memberships.id, membershipId),
          eq(memberships.kind, 'human'),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** One seat by id, scoped to the tenant; `null` if absent or cross-tenant. */
  async findById(
    runner: TenantQueryRunner,
    context: TenantContext,
    seatId: string,
  ): Promise<BillingSeatRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(billingSeats)
      .where(
        and(eq(billingSeats.organizationId, context.organizationId), eq(billingSeats.id, seatId)),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** The active seat a membership currently holds (released_at IS NULL), or `null`. */
  async findActiveForMembership(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
  ): Promise<BillingSeatRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(billingSeats)
      .where(
        and(
          eq(billingSeats.organizationId, context.organizationId),
          eq(billingSeats.membershipId, membershipId),
          isNull(billingSeats.releasedAt),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** The tenant's active seats, assigned-at ascending then id, bounded to one page. */
  async listActive(
    runner: TenantQueryRunner,
    context: TenantContext,
    limit: number = MAX_SEATS_PAGE,
  ): Promise<readonly BillingSeatRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(billingSeats)
      .where(
        and(
          eq(billingSeats.organizationId, context.organizationId),
          isNull(billingSeats.releasedAt),
        ),
      )
      .orderBy(asc(billingSeats.assignedAt), asc(billingSeats.id))
      .limit(Math.min(Math.max(1, Math.trunc(limit)), MAX_SEATS_PAGE));
  }

  /** Assign a seat to a membership. Reads the row back for the server-generated timestamp. */
  async create(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
  ): Promise<BillingSeatRow> {
    const id = uuidv7();
    await tenantDrizzle(runner)
      .insert(billingSeats)
      .values({
        id,
        organizationId: context.organizationId,
        membershipId,
        assignedAt: sql`current_timestamp(3)`,
        releasedAt: null,
      });

    const created = await this.findById(runner, context, id);
    if (!created) {
      // Unreachable: the insert above committed this row in this transaction.
      throw new Error('billing seat vanished immediately after insert');
    }
    return created;
  }

  /**
   * Reclaim a seat — a soft close that stamps `released_at`. Identity and `assigned_at` are never
   * written; the 0075 trigger refuses it. Reads the row back so the caller gets the current state.
   */
  async release(
    runner: TenantQueryRunner,
    context: TenantContext,
    seatId: string,
  ): Promise<BillingSeatRow | null> {
    await tenantDrizzle(runner)
      .update(billingSeats)
      .set({ releasedAt: sql`current_timestamp(3)` })
      .where(
        and(
          eq(billingSeats.organizationId, context.organizationId),
          eq(billingSeats.id, seatId),
          isNull(billingSeats.releasedAt),
        ),
      );
    return this.findById(runner, context, seatId);
  }
}

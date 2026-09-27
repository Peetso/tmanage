import { and, desc, eq } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { approvalDelegations, memberships } from '../../common/database/schema.js';
import type { ApprovalDelegationRow, MembershipRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * Approval-delegation store (x300) — a delegator's own delegations over `approval_delegations` rows,
 * plus the tenant-scoped membership lookup the create path resolves the delegate through. It owns the
 * delegation insert, the revoke delete, the newest-first list of a delegator's delegations, and the
 * membership resolve. It honours `25-AUTH` §6 structurally, the `doc_bookmarks` repository (x242)
 * posture:
 *
 * 1. **No unscoped read/write.** Every method's first two parameters are the `TenantQueryRunner` and
 *    the `TenantContext`.
 * 2. **The tenant comes from the context, never the DTO.** {@link InsertDelegationInput} has no
 *    `organizationId`, and {@link findMembership} scopes the membership read to the acting tenant, so
 *    a membership id from another tenant resolves to null — the row-level backstop behind the
 *    service's resolve-before-write 404.
 * 3. **The tenant predicate is on every statement**, executed through the guard (`drizzle.ts`).
 *
 * The runner is a parameter, not a field: the service composes resolve-then-insert on one connection
 * inside one transaction `TenantDatabase.transaction()` owns.
 */

/** What the service inserts. No `organizationId` (from the context); the delegator is the acting member. */
export interface InsertDelegationInput {
  readonly delegatorMembershipId: string;
  readonly delegateMembershipId: string;
  readonly startsAt: Date;
  readonly endsAt: Date;
}

/** A delegator's delegations list carries every row of its own; bound so it can never be unbounded. */
const MAX_DELEGATIONS_LISTED = 200;

export class ApprovalDelegationRepository {
  /**
   * Resolve a membership by id, scoped to the acting tenant. A membership id that belongs to another
   * tenant resolves to null even when it exists there, which is what makes the service's cross-tenant
   * refusal a 404 with nothing written.
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
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** Fetch one delegation of the acting tenant by id, or null. */
  async findById(
    runner: TenantQueryRunner,
    context: TenantContext,
    id: string,
  ): Promise<ApprovalDelegationRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(approvalDelegations)
      .where(
        and(
          eq(approvalDelegations.organizationId, context.organizationId),
          eq(approvalDelegations.id, id),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** Record a delegation for the acting delegator. Returns the inserted row. */
  async insert(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: InsertDelegationInput,
  ): Promise<ApprovalDelegationRow> {
    const id = uuidv7();
    await tenantDrizzle(runner).insert(approvalDelegations).values({
      id,
      organizationId: context.organizationId,
      delegatorMembershipId: input.delegatorMembershipId,
      delegateMembershipId: input.delegateMembershipId,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      createdAt: new Date(),
    });
    const inserted = await this.findById(runner, context, id);
    return inserted as ApprovalDelegationRow;
  }

  /**
   * Revoke one delegation of the acting delegator, scoped to the acting tenant. Idempotent: a missing
   * or already-revoked id (including a cross-tenant id, which does not match the delegator predicate)
   * removes nothing and is still success.
   */
  async remove(
    runner: TenantQueryRunner,
    context: TenantContext,
    id: string,
    delegatorMembershipId: string,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .delete(approvalDelegations)
      .where(
        and(
          eq(approvalDelegations.organizationId, context.organizationId),
          eq(approvalDelegations.id, id),
          eq(approvalDelegations.delegatorMembershipId, delegatorMembershipId),
        ),
      );
  }

  /** List one delegator's delegations in the acting tenant, newest first. Bounded. */
  async listForDelegator(
    runner: TenantQueryRunner,
    context: TenantContext,
    delegatorMembershipId: string,
  ): Promise<readonly ApprovalDelegationRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(approvalDelegations)
      .where(
        and(
          eq(approvalDelegations.organizationId, context.organizationId),
          eq(approvalDelegations.delegatorMembershipId, delegatorMembershipId),
        ),
      )
      .orderBy(desc(approvalDelegations.createdAt), desc(approvalDelegations.id))
      .limit(MAX_DELEGATIONS_LISTED);
  }
}

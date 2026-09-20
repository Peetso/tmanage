import { and, asc, eq, inArray } from 'drizzle-orm';
import { PENDING_APPROVAL_STATES } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { approvals } from '../../common/database/schema.js';
import type { ApprovalRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * HOME-04's read half — the pending approvals in this tenant, read-only, for the Waiting list.
 *
 * ## Why this lives here and not in the approvals module
 *
 * The approvals module (`ApprovalsRepository`) reads and writes one approval at a time by id for
 * the decide flow; it has no "list the pending ones" method, and this slice adds nothing to it.
 * As x93's `MyDayRepository` reads the `work_items` table directly rather than reaching into the
 * work module, this reads the `approvals` table directly — it adds no method to the approvals
 * module and shares nothing that module's own slices touch.
 *
 * ## What it filters, and what it deliberately does not
 *
 * The query filters `organization_id` + a pending-state set (`requested`, `viewed` — the states
 * `PENDING_APPROVAL_STATES` names, in which a reviewer may still be asked to decide). Tenant
 * scope is the `organization_id` predicate, identical to the sibling reads, so a cross-tenant row
 * is never selected here.
 *
 * The **reviewer relation** — is the acting user in this approval's `reviewer_ids` — is NOT a
 * column, it is a JSON array, so it is applied by {@link HomeService} over the rows (the same
 * predicate x92 feeds to `isAssignedReviewer`: a user not in `reviewer_ids` never sees the
 * approval). Keeping it in the service makes the rule provable over fakes, exactly as the My Day
 * read authorizes each row above its tenant-scoped SQL. A SQL-side `JSON_CONTAINS` reviewer
 * filter and a fitted index are the scale follow-up; a tenant's pending-approval set is bounded.
 */
export class WaitingRepository {
  /**
   * Every pending approval in this tenant, oldest request first then by id for a stable read.
   *
   * The reason tag and Waiting order are applied by {@link HomeService}; the reviewer filter is
   * too. Read-only — no page cursor for this first slice, matching the My Day read.
   */
  async listPending(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<readonly ApprovalRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(approvals)
      .where(
        and(
          eq(approvals.organizationId, context.organizationId),
          inArray(approvals.state, [...PENDING_APPROVAL_STATES]),
        ),
      )
      .orderBy(asc(approvals.createdAt), asc(approvals.id));
  }
}

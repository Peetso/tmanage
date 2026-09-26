import { and, asc, eq, inArray } from 'drizzle-orm';
import { PENDING_APPROVAL_STATES } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { approvals, clientRequests } from '../../common/database/schema.js';
import type { ApprovalRow, ClientRequestRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * The client-request states the Waiting section reads (HOME-04 client-wait + stale buckets).
 *
 * `submitted` and `triage` are "awaiting the studio's action" (the client-wait bucket).
 * `needs_clarification` is "awaiting the *client's* answer" — read here too, but only its aged
 * rows become the stale-follow-up bucket; {@link HomeService} applies the age test. Accepted,
 * planned, delivered and the terminal states are not waiting on anyone the studio can act on, so
 * they are never selected. `23-ERD-AND-STATE-MACHINES` §6.
 */
const HOME_OPEN_CLIENT_REQUEST_STATES = ['submitted', 'triage', 'needs_clarification'] as const;

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

  /**
   * Every open client request in this tenant — those `submitted`, in `triage`, or in
   * `needs_clarification` — oldest change first then by id for a stable read.
   *
   * Read-only, and reads the `client_requests` table directly for the same reason
   * {@link WaitingRepository.listPending} reads `approvals` directly rather than reaching into the
   * requests module: the module's own list is a paginated triage queue, and this slice adds no
   * method to it. Tenant scope is the `organization_id` predicate, identical to
   * `ClientRequestsRepository.list`, so a cross-tenant row is never selected.
   *
   * The **triage relation** — is the caller a triager on this row's project — is applied by
   * {@link HomeService} (`client_request.triage`, the same gate `ClientRequestsService.mayTriage`
   * applies), and the **stale-age test** over `needs_clarification` too, so both are provable over
   * fakes. `ix_client_requests_org_project_state` covers the predicate; a tenant's open set is
   * bounded, so no page cursor for this read, matching {@link listPending}.
   */
  async listOpenClientRequests(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<readonly ClientRequestRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(clientRequests)
      .where(
        and(
          eq(clientRequests.organizationId, context.organizationId),
          inArray(clientRequests.state, [...HOME_OPEN_CLIENT_REQUEST_STATES]),
        ),
      )
      .orderBy(asc(clientRequests.updatedAt), asc(clientRequests.id));
  }
}

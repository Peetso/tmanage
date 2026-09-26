import { and, asc, eq, inArray } from 'drizzle-orm';
import { CLIENT_REQUEST_STATES, clientRequestStateMachine } from '@tmanage/domain';
import type { ClientRequestState } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { clientRequests } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * Request aging — module 11's read seam (x154). The studio's overdue-to-triage / long-uncommitted
 * view over the requests that are still open (audit: "Requests Partial; aging/SLA view not built").
 *
 * It adds no table and writes nothing: a single tenant-scoped `SELECT` over `client_requests`
 * (REQ-001's own table, 0006), oldest first, bounded. The bucketing — fresh/aging/overdue by
 * age-since-created — and the per-row `client_request.triage` relation check are the controller's,
 * exactly as INS-06's adoption repository keeps `authorize()` out of the read (the controller owns
 * policy; the repository owns the query).
 *
 * ## Only the open requests
 *
 * The set is the non-terminal states, derived from `clientRequestStateMachine` rather than written
 * out here, so a terminal request (`declined`, `delivered`, `withdrawn`) never appears in an aging
 * queue — a delivered request is not "overdue", and the definition of "closed" stays the machine's.
 *
 * ## Tenancy is in SQL, and re-checked above
 *
 * The predicate is `organization_id = context.organizationId` on every read, so a cross-tenant row
 * is never returned in production; each row still carries `organizationId` so the controller can
 * drop a foreign row belt-and-braces before it is bucketed — the FAST-PROTOCOL Known-trap (scope
 * before the count), the same defence the sibling reads apply.
 */

/** The states a request can be in while it is still open — the machine's non-terminal set. */
export const OPEN_CLIENT_REQUEST_STATES: readonly ClientRequestState[] =
  CLIENT_REQUEST_STATES.filter((state) => !clientRequestStateMachine.isTerminal(state));

/**
 * One open request, as the aging read sees it. No `View` suffix: this is the repository's row, not a
 * wire projection — the controller turns it into the aged item the API returns.
 */
export interface OpenRequestRow {
  readonly organizationId: string;
  readonly id: string;
  readonly title: string;
  readonly state: string;
  readonly projectId: string;
  readonly clientOrganizationId: string;
  /** When the client submitted it — the anchor age is measured from. */
  readonly createdAt: Date;
  /** `null` until the studio has committed a date or an explicit unscheduled state. */
  readonly commitment: string | null;
}

/** How many open requests a single aging read will scan and return. A real bound, not a page cursor. */
export const DEFAULT_AGING_LIMIT = 100;
export const MAX_AGING_LIMIT = 500;

export class RequestAgingRepository {
  /**
   * The open requests for the acting tenant, oldest first, bounded.
   *
   * `IN (open states)` keeps the read to the requests an aging queue is about; `order by created_at`
   * ascending puts the oldest — the ones most likely overdue — first, which is also the order the
   * bounded page keeps, so the page never silently drops the oldest. The limit is clamped to
   * `[1, MAX_AGING_LIMIT]` here so a caller cannot turn one read into an unbounded scan.
   */
  async listOpen(
    runner: TenantQueryRunner,
    context: TenantContext,
    options: { limit?: number } = {},
  ): Promise<readonly OpenRequestRow[]> {
    const limit = Math.min(Math.max(options.limit ?? DEFAULT_AGING_LIMIT, 1), MAX_AGING_LIMIT);

    return tenantDrizzle(runner)
      .select({
        organizationId: clientRequests.organizationId,
        id: clientRequests.id,
        title: clientRequests.title,
        state: clientRequests.state,
        projectId: clientRequests.projectId,
        clientOrganizationId: clientRequests.clientOrganizationId,
        createdAt: clientRequests.createdAt,
        commitment: clientRequests.commitment,
      })
      .from(clientRequests)
      .where(
        and(
          eq(clientRequests.organizationId, context.organizationId),
          inArray(clientRequests.state, [...OPEN_CLIENT_REQUEST_STATES]),
        ),
      )
      .orderBy(asc(clientRequests.createdAt), asc(clientRequests.id))
      .limit(limit);
  }
}

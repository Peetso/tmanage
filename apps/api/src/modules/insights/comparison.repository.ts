import { and, count, eq, gte, isNull, lt } from 'drizzle-orm';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { meetings, workItems } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * x229's read seam — the period-over-period metric count.
 *
 * The audit's gap is plain: the insights reads are single-period — a studio can see this month's
 * numbers but has no way to set them beside another month's. x229 closes it with a **live two-window
 * compute**; this repository holds the one thing feature code may not — the driver handle — and
 * counts one metric over one caller-bound window. It is distinct from x211 snapshots (stored points
 * compared over time): nothing is stored here, no table, no column, no write.
 *
 * ## Read-only over existing data, tenant-scoped in SQL
 *
 * Each metric maps to one tenant-scoped `SELECT count(*)` over a table another module owns —
 * `work_items` (work) or `meetings` (calendar) — the same source data the adoption read counts. The
 * repository carries **no policy**: the org-level `work.read` gate lives in the controller, exactly
 * as INS-06 keeps `authorize()` out of `InsightsAdoptionRepository`. Every read filters on
 * `organization_id = context.organizationId`, so a cross-tenant row never contributes.
 *
 * ## Windows are bound Date values, never the DB clock
 *
 * The window bounds are the caller's `Date` values, bound as query parameters (`created_at >= :start
 * AND < :end`), never `now()` in SQL — the admin-pool clock trap — so the count is exactly the
 * caller's window and reproducible. The metric arrives already resolved against the service's closed
 * allowlist, so the branch here is over a known union, never caller-supplied column text.
 */

/** The metrics a comparison may be run over — a closed vocabulary, never an arbitrary column. */
export const COMPARISON_METRICS = ['work_items_created', 'meetings_held'] as const;

/** One of the known comparison metrics. */
export type ComparisonMetric = (typeof COMPARISON_METRICS)[number];

export class InsightComparisonRepository {
  /**
   * Count one metric over one window, tenant-scoped. The window bounds are bound `Date` parameters
   * (`>= start AND < end`), never the DB clock, so the count is exactly the caller's window. Filters
   * on `organization_id` from the context, so a cross-tenant row never contributes.
   */
  async countMetricInWindow(
    runner: TenantQueryRunner,
    context: TenantContext,
    metric: ComparisonMetric,
    start: Date,
    end: Date,
  ): Promise<number> {
    const db = tenantDrizzle(runner);
    const org = context.organizationId;
    const rows =
      metric === 'work_items_created'
        ? await db
            .select({ total: count() })
            .from(workItems)
            .where(
              and(
                eq(workItems.organizationId, org),
                isNull(workItems.deletedAt),
                gte(workItems.createdAt, start),
                lt(workItems.createdAt, end),
              ),
            )
        : await db
            .select({ total: count() })
            .from(meetings)
            .where(
              and(
                eq(meetings.organizationId, org),
                gte(meetings.startsAt, start),
                lt(meetings.startsAt, end),
              ),
            );
    return Number(rows[0]?.total ?? 0);
  }
}

import { and, count, eq, gte, isNull, lt } from 'drizzle-orm';
import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError } from '../../common/http/errors.js';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { meetings, workItems } from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';

/**
 * x229's service — Insight period-over-period comparison (module 15, Insights & reporting).
 *
 * The audit's gap is plain: the insights reads are single-period — a studio can see this month's
 * numbers but has no way to set them beside another month's. This closes it with a **live two-window
 * compute**: given a metric and two explicit windows, it counts the metric over each and returns the
 * two values with their difference. It is distinct from x211 snapshots (stored points compared over
 * time); nothing is stored here — no table, no column, no write, no schedule.
 *
 * ## Metric is a closed allowlist, never an arbitrary column
 *
 * The `metric` is resolved against {@link COMPARISON_METRICS}; an unknown metric is a 400, never a
 * query built from caller-supplied text. Each metric maps to one tenant-scoped count over a table an
 * existing module owns (`work_items`, `meetings`) — the same source data the adoption read counts.
 *
 * ## Windows are bound Date values, never the DB clock
 *
 * A window is `start..end`, both ISO instants the caller supplies; the service parses them into
 * `Date` values and binds them as query parameters (`created_at >= :start AND < :end`). The bounds
 * are never `now()` in SQL — the admin-pool clock trap — so the count is exactly the caller's window
 * and reproducible. A malformed or inverted window (start not before end) is a 400 with no partial
 * compute; the metric is resolved and both windows validated before either count runs.
 *
 * ## Capability and tenant scope
 *
 * Behind `work.read` (on the route, and re-checked org-level here — the internal-read capability the
 * sibling insights reads reuse, so this slice needs no capability table or role-grid edit). Every
 * count filters on `organization_id` from the context, never from input, so a comparison can never
 * read across tenants.
 */

/** The metrics a comparison may be run over — a closed vocabulary, never an arbitrary column. */
export const COMPARISON_METRICS = ['work_items_created', 'meetings_held'] as const;

/** One of the known comparison metrics. */
export type ComparisonMetric = (typeof COMPARISON_METRICS)[number];

/**
 * x229's read shape — a metric compared across two windows.
 *
 * `a` and `b` echo each window's bounds and the count computed over it; `delta` is `b − a`; `pct` is
 * the fractional change `(b − a) / a`, and is `null` when the base window's count is 0 (divide-by-zero
 * guarded — never `NaN`, never a 500). `computedAt` is the ISO instant the compute ran. Paired in
 * `e2e/contracts/api-web-shapes.ts` with the web shape the comparison screen consumes (CONTRACT-001).
 */
export interface PeriodComparisonView {
  readonly metric: ComparisonMetric;
  readonly a: PeriodResult;
  readonly b: PeriodResult;
  readonly delta: number;
  readonly pct: number | null;
  readonly computedAt: string;
}

/** One window's contribution — its bounds echoed as ISO instants and the count computed over it. */
export interface PeriodResult {
  readonly start: string;
  readonly end: string;
  readonly value: number;
}

/** A parsed, validated window — bound `Date` values the count runs between. */
interface Window {
  readonly start: Date;
  readonly end: Date;
}

/**
 * Narrow an arbitrary string to a known metric, or reject it as a 400. A caller cannot compare a
 * metric that does not exist, and the query is never built from caller-supplied column text.
 */
export function parseComparisonMetric(raw: string | undefined): ComparisonMetric {
  if (raw !== undefined && (COMPARISON_METRICS as readonly string[]).includes(raw)) {
    return raw as ComparisonMetric;
  }
  throw new ApiError(400, 'validation_failed', 'The comparison metric is invalid', [
    { field: 'metric', message: `must be one of: ${COMPARISON_METRICS.join(', ')}` },
  ]);
}

/**
 * Parse a `start..end` window into two bound `Date` values. A missing part, an unparseable instant,
 * or an inverted window (start not strictly before end) is a 400 — the read never computes over a
 * malformed or backwards window, and there is no partial result.
 */
export function parseWindow(raw: string | undefined, field: string): Window {
  const parts = raw?.split('..');
  if (!parts || parts.length !== 2) {
    throw invalidWindow(field, 'must be two ISO instants separated by ".."');
  }
  const start = new Date(parts[0] ?? '');
  const end = new Date(parts[1] ?? '');
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw invalidWindow(field, 'both bounds must be valid ISO instants');
  }
  if (start.getTime() >= end.getTime()) {
    throw invalidWindow(field, 'the start must be before the end');
  }
  return { start, end };
}

function invalidWindow(field: string, message: string): ApiError {
  return new ApiError(400, 'validation_failed', 'The comparison window is invalid', [
    { field, message },
  ]);
}

export class InsightComparisonService {
  constructor(private readonly database: TenantDatabase) {}

  /**
   * Whether this principal may read the org's insights, judged by `work.read` against the
   * organization itself (`projectId: null`, internal audience) — the org-level relation half of the
   * capability the route gated on the role, the belt-and-braces the sibling insights reads apply. A
   * client is refused (`work.read` is internal-only), and a cross-tenant principal by the tenant
   * check inside `authorize`.
   */
  mayReadOrgInsights(principal: Principal, context: TenantContext): boolean {
    return authorize({
      principal,
      capability: 'work.read',
      resource: {
        organizationId: context.organizationId,
        projectId: null,
        audience: 'internal',
        lifecycle: 'active',
      },
    }).allowed;
  }

  /**
   * Compare one metric across two windows. The metric and both windows are already resolved and
   * validated by the controller, so this only counts and arithmetic-composes. `delta` is `b − a`;
   * `pct` guards divide-by-zero (base 0 → `null`, never `NaN`).
   */
  async compare(
    context: TenantContext,
    metric: ComparisonMetric,
    a: Window,
    b: Window,
  ): Promise<PeriodComparisonView> {
    const computedAt = new Date();
    // Sequential, not `Promise.all`: one connection is bound to this unit of work and mysql2 does
    // not multiplex a connection across concurrent queries.
    const valueA = await this.count(context, metric, a);
    const valueB = await this.count(context, metric, b);

    const delta = valueB - valueA;
    const pct = valueA === 0 ? null : delta / valueA;

    return {
      metric,
      a: { start: a.start.toISOString(), end: a.end.toISOString(), value: valueA },
      b: { start: b.start.toISOString(), end: b.end.toISOString(), value: valueB },
      delta,
      pct,
      computedAt: computedAt.toISOString(),
    };
  }

  /**
   * Count one metric over one window, tenant-scoped. The window bounds are bound `Date` parameters
   * (`>= start AND < end`), never the DB clock, so the count is exactly the caller's window. Filters
   * on `organization_id` from the context, so a cross-tenant row never contributes.
   */
  private count(context: TenantContext, metric: ComparisonMetric, window: Window): Promise<number> {
    return this.database.read(context, async (runner) => {
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
                  gte(workItems.createdAt, window.start),
                  lt(workItems.createdAt, window.end),
                ),
              )
          : await db
              .select({ total: count() })
              .from(meetings)
              .where(
                and(
                  eq(meetings.organizationId, org),
                  gte(meetings.startsAt, window.start),
                  lt(meetings.startsAt, window.end),
                ),
              );
      return Number(rows[0]?.total ?? 0);
    });
  }
}

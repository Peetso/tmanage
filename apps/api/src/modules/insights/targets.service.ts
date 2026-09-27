import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { INSIGHT_TARGET_METRICS, INSIGHT_TARGET_PERIODS } from '../../common/database/schema.js';
import type {
  InsightTargetMetric,
  InsightTargetPeriod,
  InsightTargetRow,
} from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { InsightsService } from './insights.service.js';
import { InsightTargetsRepository } from './targets.repository.js';

/**
 * x230's service — Insight metric targets (module 15, Insights & reporting).
 *
 * The audit's gap: insights are reported (x133–x135) and can be snapshotted (x211) and compared
 * (x229), but there is no *target* to judge a live number against. This slice stores an org-wide goal
 * line per metric and, on the status read, compares each live figure to its target.
 *
 * ## Capability and tenant scope
 *
 * The write is org configuration, so it is behind `org.manage`; the read is behind `work.read` — the
 * internal-read capability the sibling insights reads reuse (a viewer sees targets but cannot set
 * them). Both are re-checked org-level here (the controller decorator is the coarse HTTP gate; this is
 * the tenant-checked decision). The service is the tenant-scoped data seam: every write binds
 * `organization_id` from the context (never from input), and every read filters on it, so a target can
 * never be set for, listed across, or read from another tenant.
 *
 * ## The metric is a closed vocabulary; the target is bounded
 *
 * `metric` and `period` are validated against the schema ENUMs — an unknown value is a 400, never a
 * stored row. `targetValue` is a bounded non-negative integer. The status compute guards a zero target
 * so the attainment ratio never divides by zero.
 */

/** The set/list projection — one stored target. Paired with the web shape (CONTRACT-001). */
export interface MetricTargetView {
  readonly metric: InsightTargetMetric;
  readonly targetValue: number;
  readonly period: InsightTargetPeriod;
}

/**
 * The status projection — a target with the live metric measured against it. `currentValue` is the
 * live org-wide figure; `attainment` is `currentValue / targetValue` (null when the target is zero, so
 * no divide-by-zero); `status` flags whether the live figure meets the goal. Paired with the web
 * shape (CONTRACT-001).
 */
export interface MetricTargetStatusView {
  readonly metric: InsightTargetMetric;
  readonly targetValue: number;
  readonly period: InsightTargetPeriod;
  readonly currentValue: number;
  readonly attainment: number | null;
  readonly status: 'on_track' | 'behind';
}

/** The inclusive ceiling for a target value — a goal line is a count, never unbounded. */
const MAX_TARGET_VALUE = 1_000_000;

/**
 * Narrow an arbitrary string to a known metric, or reject it as a 400. An unknown metric is never a
 * stored row and never a silently empty status — a caller cannot target a metric that does not exist.
 */
export function parseMetric(raw: unknown): InsightTargetMetric {
  if (typeof raw === 'string' && (INSIGHT_TARGET_METRICS as readonly string[]).includes(raw)) {
    return raw as InsightTargetMetric;
  }
  throw new ApiError(400, 'validation_failed', 'The metric is invalid', [
    { field: 'metric', message: `must be one of: ${INSIGHT_TARGET_METRICS.join(', ')}` },
  ]);
}

/** Narrow an arbitrary string to a known period, or reject it as a 400. */
export function parsePeriod(raw: unknown): InsightTargetPeriod {
  if (typeof raw === 'string' && (INSIGHT_TARGET_PERIODS as readonly string[]).includes(raw)) {
    return raw as InsightTargetPeriod;
  }
  throw new ApiError(400, 'validation_failed', 'The period is invalid', [
    { field: 'period', message: `must be one of: ${INSIGHT_TARGET_PERIODS.join(', ')}` },
  ]);
}

/** Narrow an arbitrary value to a bounded non-negative integer target, or reject it as a 400. */
export function parseTargetValue(raw: unknown): number {
  if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0 && raw <= MAX_TARGET_VALUE) {
    return raw;
  }
  throw new ApiError(400, 'validation_failed', 'The target value is invalid', [
    { field: 'targetValue', message: `must be an integer between 0 and ${MAX_TARGET_VALUE}` },
  ]);
}

export class InsightTargetsService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly insights: InsightsService,
    private readonly repository: InsightTargetsRepository = new InsightTargetsRepository(),
  ) {}

  /**
   * Whether this principal may manage the org's insights config — judged by `org.manage` against the
   * organization itself (`projectId: null`, internal audience). An internal role holding `org.manage`
   * passes; a client is refused (`org.manage` is internal-only), and a cross-tenant principal by the
   * tenant check inside `authorize`.
   */
  mayManageOrgInsights(principal: Principal, context: TenantContext): boolean {
    return authorize({
      principal,
      capability: 'org.manage',
      resource: {
        organizationId: context.organizationId,
        projectId: null,
        audience: 'internal',
        lifecycle: 'active',
      },
    }).allowed;
  }

  /**
   * Whether this principal may read the org's insights — judged by `work.read` against the
   * organization itself, the org-level relation half of the read route's ceiling. A client is refused
   * because `work.read` is internal-only, and a cross-tenant principal by the tenant check.
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
   * Set an org's target for one metric (create or replace, idempotent by the unique key). The metric,
   * period and value are validated before the write; `organization_id` comes from the context.
   */
  async setTarget(context: TenantContext, input: MetricTargetView): Promise<MetricTargetView> {
    await this.database.transaction(context, (runner) =>
      this.repository.upsert(runner, context, {
        metric: input.metric,
        targetValue: input.targetValue,
        period: input.period,
      }),
    );
    return input;
  }

  /** List a tenant's targets, ordered by metric. Tenant-scoped in SQL on `organization_id`. */
  async list(context: TenantContext): Promise<readonly MetricTargetView[]> {
    const rows = await this.database.read(context, (runner) =>
      this.repository.list(runner, context),
    );
    return rows.map(toView);
  }

  /**
   * Compare each stored target to its live metric value. Reuses {@link InsightsService.orgWorkload}
   * (the same code the live screen runs) for the current figures, so the status is exactly what the
   * live screen would show measured against the goal. Guards a zero target — attainment is null rather
   * than a divide error.
   */
  async status(
    context: TenantContext,
    principal: Principal,
  ): Promise<readonly MetricTargetStatusView[]> {
    const [targets, workload] = await Promise.all([
      this.list(context),
      this.insights.orgWorkload(context, principal),
    ]);
    const current: Record<InsightTargetMetric, number> = {
      open_items: workload.totals.openItemCount,
      scheduled_items: workload.totals.scheduledItemCount,
      active_projects: workload.totals.projectCount,
      active_assignees: workload.totals.assigneeCount,
    };
    return targets.map((target) => {
      const currentValue = current[target.metric];
      const attainment = target.targetValue > 0 ? currentValue / target.targetValue : null;
      return {
        metric: target.metric,
        targetValue: target.targetValue,
        period: target.period,
        currentValue,
        attainment,
        status: currentValue >= target.targetValue ? 'on_track' : 'behind',
      };
    });
  }
}

/** Project a stored row to the wire shape. */
function toView(row: InsightTargetRow): MetricTargetView {
  return { metric: row.metric, targetValue: row.targetValue, period: row.period };
}

/** The 403 the controller raises when the org-level capability check refuses. */
export function insightTargetsForbidden(): ApiError {
  return new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, 'insight_targets_denied');
}

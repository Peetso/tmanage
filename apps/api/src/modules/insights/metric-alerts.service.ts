import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { INSIGHT_ALERT_COMPARATORS, INSIGHT_ALERT_METRICS } from '../../common/database/schema.js';
import type {
  InsightAlertComparator,
  InsightAlertMetric,
  InsightMetricAlertRow,
} from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { InsightMetricAlertsRepository } from './metric-alerts.repository.js';
import { InsightSnapshotsRepository } from './snapshots.repository.js';
import { scopeSnapshotPayloadsForReader } from './snapshots.service.js';

/**
 * x319's service — Insight metric alerts (module 15, Insights & reporting).
 *
 * The audit's gap: insights are reported (x133–x135), snapshotted (x211), compared (x229) and given
 * org-wide targets (x230), but a member has no personal threshold alert — no way to say "watch open
 * items and flag it when it crosses N". This slice stores one member-owned alert per metric (a
 * comparator and a threshold) and, on the read, marks each currently breached against the latest
 * `workload` snapshot. Config + read-side evaluation only: NO dispatch or email this slice.
 *
 * ## Capability and tenant scope
 *
 * Every route is behind `work.read` — the internal-read capability the sibling insights reads reuse
 * (the permission matrix names no personal-alert capability and the pass forbids inventing one), and
 * re-checked org-level here (the controller decorator is the coarse HTTP gate; this is the
 * tenant-checked decision). The subject is always the authenticated caller: the service binds
 * `member_user_id` from `context.userId`, never from input, so no caller can set, list, or delete
 * another member's alert — the request has no way to name one.
 *
 * ## The metric is a closed vocabulary; the threshold is bounded
 *
 * `metricKey` and `comparator` are validated against the schema allowlists — an unknown value is a
 * 400, never a stored row. `threshold` is a bounded non-negative integer (the metrics it judges are
 * counts); a non-numeric or out-of-range value is a 400. The evaluation reads the latest workload
 * snapshot; when none has been captured yet the current value is null and the alert is not breached.
 */

/** The upsert projection — one stored alert. Paired with the web shape (CONTRACT-001). */
export interface MetricAlertView {
  readonly metricKey: InsightAlertMetric;
  readonly comparator: InsightAlertComparator;
  readonly threshold: number;
}

/**
 * The read projection — an alert with its live evaluation against the latest workload snapshot.
 * `currentValue` is the live figure the snapshot froze (null when no snapshot exists yet, so no
 * fabricated number); `breached` is whether the comparator/threshold is met by it (false when there is
 * nothing to evaluate against). Paired with the web shape (CONTRACT-001).
 */
export interface MetricAlertStatusView {
  readonly metricKey: InsightAlertMetric;
  readonly comparator: InsightAlertComparator;
  readonly threshold: number;
  readonly currentValue: number | null;
  readonly breached: boolean;
}

/** The inclusive ceiling for a threshold — the metrics an alert judges are counts, never unbounded. */
const MAX_THRESHOLD = 1_000_000;

/** Maps each metric key to its numeric field inside a `workload` snapshot's `totals` payload. */
const METRIC_TOTALS_FIELD: Record<InsightAlertMetric, string> = {
  open_items: 'openItemCount',
  scheduled_items: 'scheduledItemCount',
  active_projects: 'projectCount',
  active_assignees: 'assigneeCount',
};

/** Narrow an arbitrary value to a known metric key, or reject it as a 400 (never a stored row). */
export function parseMetricKey(raw: unknown): InsightAlertMetric {
  if (typeof raw === 'string' && (INSIGHT_ALERT_METRICS as readonly string[]).includes(raw)) {
    return raw as InsightAlertMetric;
  }
  throw new ApiError(400, 'validation_failed', 'The metric key is invalid', [
    { field: 'metricKey', message: `must be one of: ${INSIGHT_ALERT_METRICS.join(', ')}` },
  ]);
}

/** Narrow an arbitrary value to a known comparator, or reject it as a 400. */
export function parseComparator(raw: unknown): InsightAlertComparator {
  if (typeof raw === 'string' && (INSIGHT_ALERT_COMPARATORS as readonly string[]).includes(raw)) {
    return raw as InsightAlertComparator;
  }
  throw new ApiError(400, 'validation_failed', 'The comparator is invalid', [
    { field: 'comparator', message: `must be one of: ${INSIGHT_ALERT_COMPARATORS.join(', ')}` },
  ]);
}

/** Narrow an arbitrary value to a bounded non-negative integer threshold, or reject it as a 400. */
export function parseThreshold(raw: unknown): number {
  if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0 && raw <= MAX_THRESHOLD) {
    return raw;
  }
  throw new ApiError(400, 'validation_failed', 'The threshold is invalid', [
    { field: 'threshold', message: `must be an integer between 0 and ${MAX_THRESHOLD}` },
  ]);
}

export class InsightMetricAlertsService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly repository: InsightMetricAlertsRepository = new InsightMetricAlertsRepository(),
    private readonly snapshots: InsightSnapshotsRepository = new InsightSnapshotsRepository(),
  ) {}

  /**
   * Whether this principal may read the org's insights — judged by `work.read` against the
   * organization itself (`projectId: null`, internal audience), the org-level relation half of the
   * route's ceiling. A client is refused (`work.read` is internal-only), and a cross-tenant principal
   * by the tenant check inside `authorize`.
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
   * Create or replace the caller's alert for one metric (idempotent by the unique key). The metric,
   * comparator and threshold are validated by the controller; `organization_id`/`member_user_id` come
   * from the context/caller, never from input.
   */
  async set(
    context: TenantContext,
    principal: Principal,
    input: MetricAlertView,
  ): Promise<MetricAlertView> {
    await this.database.transaction(context, (runner) =>
      this.repository.upsert(runner, context, {
        memberUserId: principal.userId,
        metricKey: input.metricKey,
        comparator: input.comparator,
        threshold: input.threshold,
      }),
    );
    return input;
  }

  /**
   * List the caller's alerts, each evaluated against the latest workload snapshot (read-only). The
   * snapshot payload is opaque JSON; the evaluation pulls the metric's total out of it and marks
   * breached, or leaves `currentValue` null and `breached` false when no snapshot exists yet.
   */
  async list(
    context: TenantContext,
    principal: Principal,
  ): Promise<readonly MetricAlertStatusView[]> {
    const [rows, payload] = await Promise.all([
      this.database.read(context, (runner) =>
        this.repository.listForMember(runner, context, principal.userId),
      ),
      this.database.read(context, (runner) =>
        this.repository.latestWorkloadPayload(runner, context),
      ),
    ]);
    // F21: evaluate against the latest workload snapshot as *this reader* may see it — projects
    // they cannot read are dropped and the totals recomputed, never the capturer's totals.
    const [scoped] =
      payload === undefined
        ? [undefined]
        : await scopeSnapshotPayloadsForReader(
            this.database,
            context,
            principal,
            [{ kind: 'workload', payload }],
            this.snapshots,
          );
    const totals = extractTotals(scoped);
    return rows.map((row) => evaluate(row, totals));
  }

  /** Delete the caller's alert for one metric. Idempotent — absent or another member's is a no-op 204. */
  async remove(
    context: TenantContext,
    principal: Principal,
    metricKey: InsightAlertMetric,
  ): Promise<void> {
    await this.database.transaction(context, (runner) =>
      this.repository.deleteOwn(runner, context, principal.userId, metricKey),
    );
  }
}

/**
 * Pull the numeric `totals` map out of an opaque workload-snapshot payload. Returns null when the
 * payload is absent or not the expected shape — the evaluation then reports no current value rather
 * than guessing one.
 */
function extractTotals(payload: unknown): Record<string, number> | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const totals = (payload as { totals?: unknown }).totals;
  if (typeof totals !== 'object' || totals === null) return null;
  return totals as Record<string, number>;
}

/** Evaluate one alert row against the extracted totals — the read-side breach decision. */
function evaluate(
  row: InsightMetricAlertRow,
  totals: Record<string, number> | null,
): MetricAlertStatusView {
  const field = METRIC_TOTALS_FIELD[row.metricKey];
  const raw = totals ? totals[field] : undefined;
  const currentValue = typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
  const breached =
    currentValue === null
      ? false
      : row.comparator === 'gte'
        ? currentValue >= row.threshold
        : currentValue <= row.threshold;
  return {
    metricKey: row.metricKey,
    comparator: row.comparator,
    threshold: row.threshold,
    currentValue,
    breached,
  };
}

/** The 403 the controller raises when the org-level `work.read` check refuses. */
export function insightMetricAlertsForbidden(): ApiError {
  return new ApiError(
    403,
    'forbidden',
    MESSAGES.forbidden,
    undefined,
    'insight_metric_alerts_denied',
  );
}

import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { BillingUsageAlertRow } from '../../common/database/schema.js';
import { UsageAlertsRepository } from './usage-alerts.repository.js';
import { USAGE_ALERT_METRICS } from './usage-alerts.types.js';
import type { UsageAlertMetric } from './usage-alerts.types.js';

/**
 * Billing & entitlements (module 19, x200). The usage-alerts service — the business layer over the
 * usage-alert threshold rules. It follows the `automation_schedules` service posture: it holds the
 * {@link TenantDatabase} and the repository, opens the read/transaction, and makes the authoritative
 * authorization decision. No driver handle lives here (the repository holds it), so this file is free of
 * the `no-restricted-imports` boundary that reserves `drizzle-orm` for repository/database modules.
 *
 * ## The capability
 *
 * Billing is an org-admin concern, so every method reuses `org.manage` — no billing capability exists
 * and this slice adds none (the same divergence `usage.service.ts` records). The route guard asks the
 * coarse ceiling question; this service adds the authoritative application decision (`25-AUTH` §3 step 2,
 * deny-by-default): an org-scoped `authorize()` (`projectId: null`) that a suspended membership fails.
 *
 * ## The Known-trap order
 *
 * The tenant comes from the context the guard resolved, never the body. On the update path the rule is
 * resolved tenant-scoped **before** authorize/write: a cross-tenant or missing id is a 404, never a
 * foreign-key surprise. Validation (off-list metric, out-of-range threshold) is the controller's, done
 * before this service is called; nothing here writes on an invalid input.
 *
 * ## What it does, and what it cannot
 *
 * {@link status} *computes* which rules are breached from the bands the usage counters already carry; it
 * dispatches nothing. Email / notification delivery when a threshold is crossed is worker infrastructure
 * (Needs-Peter), out of this slice.
 */

/** What a caller is allowed to see of one usage-alert rule. `organizationId` is deliberately absent. */
export interface UsageAlertView {
  readonly id: string;
  readonly metric: string;
  readonly thresholdPercent: number;
  readonly active: boolean;
  readonly createdBy: string;
  /** An ISO-8601 instant. */
  readonly createdAt: string;
  /** An ISO-8601 instant. */
  readonly updatedAt: string;
}

/**
 * One rule's current evaluation — the metric, its configured threshold, whether it is active, the
 * current percent-of-quota band, and whether that band is at or above the threshold. `breached` is
 * `true` only when the rule is active and the current band meets the threshold.
 */
export interface UsageAlertStatusView {
  readonly metric: string;
  readonly thresholdPercent: number;
  readonly active: boolean;
  readonly currentPercent: number;
  readonly breached: boolean;
}

/** What the service's create accepts. `metric`/`thresholdPercent` are already validated by the caller. */
export interface CreateUsageAlertParams {
  readonly metric: UsageAlertMetric;
  readonly thresholdPercent: number;
  readonly active: boolean;
}

/** What the service's update accepts. At least one field is present (the controller enforces that). */
export interface UpdateUsageAlertParams {
  readonly thresholdPercent?: number;
  readonly active?: boolean;
}

/** An explicit projection, not a serialised row: a column added later is invisible until named. */
function toView(row: BillingUsageAlertRow): UsageAlertView {
  return {
    id: row.id,
    metric: row.metric,
    thresholdPercent: row.thresholdPercent,
    active: row.active,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * The pure evaluation: pair each rule with the current band of its metric and flag a breach. Exported so
 * a unit proof can exercise it directly. A rule whose metric has no counter band reads as 0% and is
 * never breached.
 */
export function evaluateAlertStatuses(
  rows: readonly BillingUsageAlertRow[],
  bands: ReadonlyMap<UsageAlertMetric, number>,
): readonly UsageAlertStatusView[] {
  return rows.map((row) => {
    const currentPercent = bands.get(row.metric as UsageAlertMetric) ?? 0;
    return {
      metric: row.metric,
      thresholdPercent: row.thresholdPercent,
      active: row.active,
      currentPercent,
      breached: row.active && currentPercent >= row.thresholdPercent,
    };
  });
}

export class UsageAlertsService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly alerts: UsageAlertsRepository = new UsageAlertsRepository(),
  ) {}

  /** List the acting tenant's usage-alert rules, metric-ascending, for an org admin. */
  async list(context: TenantContext, principal: Principal): Promise<readonly UsageAlertView[]> {
    this.requireOrgManage(principal, context, 'usage_alert.list');
    const rows = await this.database.read(context, (runner) => this.alerts.list(runner, context));
    return rows.map(toView);
  }

  /** Compute which rules are currently breached, over the usage counters' existing bands. */
  async status(
    context: TenantContext,
    principal: Principal,
  ): Promise<readonly UsageAlertStatusView[]> {
    this.requireOrgManage(principal, context, 'usage_alert.status');
    const { rows, bands } = await this.database.read(context, async (runner) => ({
      rows: await this.alerts.list(runner, context),
      bands: await this.alerts.readUsageBands(runner, context),
    }));
    return evaluateAlertStatuses(rows, bands);
  }

  /**
   * Create a usage-alert rule. `org.manage` org-scoped (a 403 for a caller without it). The caller has
   * already validated `metric` and `thresholdPercent`; nothing is written on an invalid input.
   */
  async create(
    context: TenantContext,
    principal: Principal,
    params: CreateUsageAlertParams,
  ): Promise<UsageAlertView> {
    this.requireOrgManage(principal, context, 'usage_alert.create');
    const row = await this.database.transaction(context, (tx) =>
      this.alerts.create(tx, context, { ...params, createdBy: context.userId }),
    );
    return toView(row);
  }

  /**
   * Update a rule's threshold and/or active flag. The rule is resolved tenant-scoped **before** the
   * authorize/write: a cross-tenant or missing id is a 404. `org.manage` org-scoped besides.
   */
  async update(
    context: TenantContext,
    principal: Principal,
    id: string,
    patch: UpdateUsageAlertParams,
  ): Promise<UsageAlertView> {
    const existing = await this.database.read(context, (runner) =>
      this.alerts.findById(runner, context, id),
    );
    if (!existing) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'usage_alert_not_visible');
    }
    this.requireOrgManage(principal, context, 'usage_alert.update');
    const row = await this.database.transaction(context, (tx) =>
      this.alerts.update(tx, context, id, patch),
    );
    return toView(row);
  }

  /** Org-scoped deny-by-default decision the route guard cannot make (membership status, etc.). */
  private requireOrgManage(principal: Principal, context: TenantContext, action: string): void {
    const verdict = authorize({
      principal,
      capability: 'org.manage',
      resource: {
        organizationId: context.organizationId,
        projectId: null,
        audience: 'internal',
        lifecycle: 'active',
      },
    });
    if (!verdict.allowed) {
      throw new ApiError(
        403,
        'forbidden',
        MESSAGES.forbidden,
        undefined,
        `${action}:${verdict.code}`,
      );
    }
  }
}

/** Re-exported so callers and proofs need one import for the metric allowlist. */
export { USAGE_ALERT_METRICS };
export type { UsageAlertMetric };

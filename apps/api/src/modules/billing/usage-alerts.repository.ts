import { and, asc, eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { billingUsageAlerts, usageCounters } from '../../common/database/schema.js';
import type { BillingUsageAlertRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';
import { METRIC_COUNTER_KEYS, USAGE_ALERT_METRICS } from './usage-alerts.types.js';
import type { UsageAlertMetric } from './usage-alerts.types.js';

/**
 * Billing & entitlements (module 19, x200). The usage-alerts repository — the data-access layer behind
 * the usage-alert threshold rules, following the `workflow_templates` repository pattern
 * (`25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md` §6):
 *
 * 1. **No unscoped read/write.** Every method's first two parameters are the `TenantQueryRunner` for
 *    the current unit of work and the `TenantContext`. There is no overload without a context.
 * 2. **The tenant comes from the context, never the DTO.** {@link CreateUsageAlertInput} has no
 *    `organizationId`, so a request body cannot choose the tenant it writes into.
 * 3. **The tenant predicate is on every statement**, built with Drizzle and executed through the guard
 *    (`drizzle.ts`), so a forgotten predicate throws rather than leaking rows.
 *
 * `metric` is allowlist-validated and `thresholdPercent` bounded by the service before any method here
 * is called. The status read reuses the bands the existing `usage_counters` write path already computes
 * (0024) rather than re-deriving used/limit here — this slice adds no counting.
 */

/**
 * What the service creates. No `organizationId` (from the context), so a request body cannot choose the
 * tenant it writes into. `metric` is already allowlist-validated and `thresholdPercent` bounded 1–100.
 */
export interface CreateUsageAlertInput {
  readonly metric: UsageAlertMetric;
  readonly thresholdPercent: number;
  readonly active: boolean;
  /** The person creating the rule — the service passes `context.userId`. */
  readonly createdBy: string;
}

/** What the service may change on an existing rule: the threshold and/or the active flag. */
export interface UpdateUsageAlertInput {
  readonly thresholdPercent?: number;
  readonly active?: boolean;
}

export class UsageAlertsRepository {
  /** List a tenant's rules, metric-ascending, within the acting tenant. */
  async list(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<readonly BillingUsageAlertRow[]> {
    const db = tenantDrizzle(runner);
    return db
      .select()
      .from(billingUsageAlerts)
      .where(eq(billingUsageAlerts.organizationId, context.organizationId))
      .orderBy(asc(billingUsageAlerts.metric));
  }

  /**
   * Fetch one rule by id, within the acting tenant. No `findById(id)` without a context: on MySQL that
   * would return another customer's row. A cross-tenant id resolves to null here.
   */
  async findById(
    runner: TenantQueryRunner,
    context: TenantContext,
    id: string,
  ): Promise<BillingUsageAlertRow | null> {
    const db = tenantDrizzle(runner);
    const rows = await db
      .select()
      .from(billingUsageAlerts)
      .where(
        and(
          eq(billingUsageAlerts.organizationId, context.organizationId),
          eq(billingUsageAlerts.id, id),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Create a rule. The id is generated here (UUIDv7). `organization_id` comes from the context, never
   * from `input`. The row is read back so the server-generated timestamps are returned.
   */
  async create(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: CreateUsageAlertInput,
  ): Promise<BillingUsageAlertRow> {
    const db = tenantDrizzle(runner);
    const id = uuidv7();

    await db.insert(billingUsageAlerts).values({
      id,
      // From the context. Not from `input` — there is no such field.
      organizationId: context.organizationId,
      metric: input.metric,
      thresholdPercent: input.thresholdPercent,
      active: input.active,
      createdBy: input.createdBy,
      createdAt: sql`current_timestamp(3)`,
      updatedAt: sql`current_timestamp(3)`,
    });

    const created = await this.findById(runner, context, id);
    if (!created) throw new Error(`billing usage alert ${id} vanished after insert`);
    return created;
  }

  /**
   * Update a rule's threshold and/or active flag, within the acting tenant. Identity (organization,
   * author, metric) is never touched — the engine trigger pins it besides. Returns the fresh row.
   */
  async update(
    runner: TenantQueryRunner,
    context: TenantContext,
    id: string,
    patch: UpdateUsageAlertInput,
  ): Promise<BillingUsageAlertRow> {
    const db = tenantDrizzle(runner);
    await db
      .update(billingUsageAlerts)
      .set({
        ...(patch.thresholdPercent === undefined
          ? {}
          : { thresholdPercent: patch.thresholdPercent }),
        ...(patch.active === undefined ? {} : { active: patch.active }),
        updatedAt: sql`current_timestamp(3)`,
      })
      .where(
        and(
          eq(billingUsageAlerts.organizationId, context.organizationId),
          eq(billingUsageAlerts.id, id),
        ),
      );

    const updated = await this.findById(runner, context, id);
    if (!updated) throw new Error(`billing usage alert ${id} vanished after update`);
    return updated;
  }

  /**
   * The current percent-of-quota band for each alert metric, read from the existing `usage_counters`
   * rows for the acting tenant. Keyed by {@link UsageAlertMetric}; a metric with no counter row is
   * absent (the caller reads that as 0%). Bands are the 0/70/85/95/100 values the write path stamps
   * (0024), reused here rather than re-derived — the status read counts nothing.
   */
  async readUsageBands(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<ReadonlyMap<UsageAlertMetric, number>> {
    const db = tenantDrizzle(runner);
    const rows = await db
      .select({ metricKey: usageCounters.metricKey, band: usageCounters.thresholdBand })
      .from(usageCounters)
      .where(eq(usageCounters.organizationId, context.organizationId));

    const byKey = new Map<string, number>();
    for (const row of rows) byKey.set(row.metricKey, Number(row.band));

    const bands = new Map<UsageAlertMetric, number>();
    for (const metric of USAGE_ALERT_METRICS) {
      const value = byKey.get(METRIC_COUNTER_KEYS[metric]);
      if (value !== undefined) bands.set(metric, value);
    }
    return bands;
  }
}

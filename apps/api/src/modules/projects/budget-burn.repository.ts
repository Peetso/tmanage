import { and, asc, eq, gt, gte, inArray, lte, sql } from 'drizzle-orm';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { projectBudgets, timeLogPricing, workItemTimeLogs } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * 52-05 (R16-b) — the burn reads and the cache refresh. Every statement names the acting tenant
 * (25 §6). Used figures come from `work_item_time_logs` by `project_id` (`ix_witl_project_day`):
 * minutes count every entry; money is `SUM(rate_snapshot_minor * minutes) / 60` over **billable**
 * entries, and an entry with no rate snapshot prices at 0 and is reported as unpriced.
 */

export interface UsedTotals {
  readonly usedMinutes: number;
  readonly usedAmountMinor: number;
}

export interface BurnBucketRow {
  /** The week's Monday (`YYYY-MM-DD`) or the person's user id. */
  readonly key: string;
  readonly minutes: number;
  readonly billableMinutes: number;
  readonly amountMinor: number;
  readonly unpricedMinutes: number;
}

export interface BurnQuery {
  readonly projectId: string;
  readonly from: string;
  readonly to: string;
  readonly groupBy: 'week' | 'person';
  /** Keyset cursor for `person`: the last user id of the previous page. */
  readonly after?: string;
  readonly limit: number;
}

export interface BudgetBurnFacts {
  readonly projectId: string;
  readonly budgetType: string;
  readonly budgetMinutes: number | null;
  readonly budgetAmountMinor: number | null;
  readonly includeExpenses: boolean;
  readonly clientVisible: boolean;
  readonly usedMinutesCache: number;
  readonly usedAmountCacheMinor: number;
}

const minutesSum = sql<string>`coalesce(sum(${workItemTimeLogs.minutes}), 0)`;
const billableMinutesSum = sql<string>`coalesce(sum(case when ${workItemTimeLogs.billable} = 1 then ${workItemTimeLogs.minutes} else 0 end), 0)`;
const amountSum = sql<string>`coalesce(floor(sum(case when ${workItemTimeLogs.billable} = 1 then ${timeLogPricing.rateSnapshotMinor} * ${workItemTimeLogs.minutes} else 0 end) / 60), 0)`;
const unpricedSum = sql<string>`coalesce(sum(case when ${workItemTimeLogs.billable} = 1 and ${timeLogPricing.rateSnapshotMinor} is null then ${workItemTimeLogs.minutes} else 0 end), 0)`;

const BURN_FACT_COLUMNS = {
  projectId: projectBudgets.projectId,
  budgetType: projectBudgets.budgetType,
  budgetMinutes: projectBudgets.budgetMinutes,
  budgetAmountMinor: projectBudgets.budgetAmountMinor,
  includeExpenses: projectBudgets.includeExpenses,
  clientVisible: projectBudgets.clientVisible,
  usedMinutesCache: projectBudgets.usedMinutesCache,
  usedAmountCacheMinor: projectBudgets.usedAmountCacheMinor,
};

export class BudgetBurnRepository {
  /** One indexed SUM over the project's time entries. */
  async usedTotals(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectId: string,
  ): Promise<UsedTotals> {
    const rows = await tenantDrizzle(runner)
      .select({ minutes: minutesSum, amount: amountSum })
      .from(workItemTimeLogs)
      .where(
        and(
          eq(workItemTimeLogs.organizationId, context.organizationId),
          eq(workItemTimeLogs.projectId, projectId),
        ),
      );
    return {
      usedMinutes: Number(rows[0]?.minutes ?? 0),
      usedAmountMinor: Number(rows[0]?.amount ?? 0),
    };
  }

  /**
   * Recompute the cache columns from the SUM. `updated_at` is set to itself so a refresh never
   * reads as a budget save. A project with no budget row updates nothing.
   */
  async refreshCache(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectId: string,
  ): Promise<UsedTotals> {
    const totals = await this.usedTotals(runner, context, projectId);
    await tenantDrizzle(runner)
      .update(projectBudgets)
      .set({
        usedMinutesCache: totals.usedMinutes,
        usedAmountCacheMinor: totals.usedAmountMinor,
        cacheRefreshedAt: sql`current_timestamp(3)`,
        updatedAt: sql`${projectBudgets.updatedAt}`,
      })
      .where(
        and(
          eq(projectBudgets.organizationId, context.organizationId),
          eq(projectBudgets.projectId, projectId),
        ),
      );
    return totals;
  }

  /** The burn grouped by week (Monday) or by person, within `[from, to]`. */
  async buckets(
    runner: TenantQueryRunner,
    context: TenantContext,
    query: BurnQuery,
  ): Promise<readonly BurnBucketRow[]> {
    const key =
      query.groupBy === 'week'
        ? sql<string>`date_format(date_sub(${workItemTimeLogs.spentOn}, interval weekday(${workItemTimeLogs.spentOn}) day), '%Y-%m-%d')`
        : sql<string>`${workItemTimeLogs.loggedBy}`;
    const predicates = [
      eq(workItemTimeLogs.organizationId, context.organizationId),
      eq(workItemTimeLogs.projectId, query.projectId),
      gte(workItemTimeLogs.spentOn, query.from),
      lte(workItemTimeLogs.spentOn, query.to),
    ];
    if (query.groupBy === 'person' && query.after !== undefined) {
      predicates.push(gt(workItemTimeLogs.loggedBy, query.after));
    }
    const rows = await tenantDrizzle(runner)
      .select({
        key,
        minutes: minutesSum,
        billableMinutes: billableMinutesSum,
        amountMinor: amountSum,
        unpricedMinutes: unpricedSum,
      })
      .from(workItemTimeLogs)
      .where(and(...predicates))
      .groupBy(key)
      .orderBy(asc(key))
      .limit(query.limit);
    return rows.map((row) => ({
      key: String(row.key),
      minutes: Number(row.minutes),
      billableMinutes: Number(row.billableMinutes),
      amountMinor: Number(row.amountMinor),
      unpricedMinutes: Number(row.unpricedMinutes),
    }));
  }

  /** The budget facts the burn needs, for many projects (portfolio) or one (portal). */
  async facts(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectIds: readonly string[],
  ): Promise<readonly BudgetBurnFacts[]> {
    if (projectIds.length === 0) return [];
    return tenantDrizzle(runner)
      .select(BURN_FACT_COLUMNS)
      .from(projectBudgets)
      .where(
        and(
          eq(projectBudgets.organizationId, context.organizationId),
          inArray(projectBudgets.projectId, [...projectIds]),
        ),
      );
  }
}

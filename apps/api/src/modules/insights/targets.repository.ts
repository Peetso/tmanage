import { and, asc, eq, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { insightTargets } from '../../common/database/schema.js';
import type {
  InsightTargetMetric,
  InsightTargetPeriod,
  InsightTargetRow,
} from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * x230's data seam — the tenant-scoped reads and the one upsert over `insight_targets`.
 *
 * A repository is the only layer allowed a driver handle (25-AUTH-AND-TENANT-ISOLATION §6); the
 * service takes a `TenantQueryRunner` from `TenantDatabase.transaction()` / `.read()` and hands it
 * here. Every statement filters or binds `organization_id` from the context — never from input — so a
 * target can never be set for, listed across, or read from another tenant. The reads carry no policy:
 * the `org.manage` write / `work.read` read gates live in the controller.
 */

/** The upsert shape. `organizationId` is absent — it is taken from the context, never from input. */
export interface UpsertInsightTargetInput {
  readonly metric: InsightTargetMetric;
  readonly targetValue: number;
  readonly period: InsightTargetPeriod;
}

export class InsightTargetsRepository {
  /**
   * Create or replace an org's target for one metric. A single `INSERT ... ON DUPLICATE KEY UPDATE`
   * against `uq_insight_targets_org_metric`, so two saves for one metric serialise on the unique key
   * rather than on a row this code read first — a lost update is not expressible. The insert path
   * fills `id`/`created_at`; the update path moves only `target_value`/`period` (identity is pinned by
   * the 0102 trigger), and `updated_at` follows the column's `ON UPDATE`.
   */
  async upsert(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: UpsertInsightTargetInput,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .insert(insightTargets)
      .values({
        id: uuidv7(),
        organizationId: context.organizationId,
        metric: input.metric,
        targetValue: input.targetValue,
        period: input.period,
        createdAt: sql`current_timestamp(3)`,
        updatedAt: sql`current_timestamp(3)`,
      })
      .onDuplicateKeyUpdate({
        set: {
          targetValue: input.targetValue,
          period: input.period,
        },
      });
  }

  /** List a tenant's targets, ordered by metric — the whole set is small (one per metric). */
  async list(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<readonly InsightTargetRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(insightTargets)
      .where(eq(insightTargets.organizationId, context.organizationId))
      .orderBy(asc(insightTargets.metric));
  }

  /** Fetch one metric's target, tenant-scoped on `(organization_id, metric)` — or undefined. */
  async findByMetric(
    runner: TenantQueryRunner,
    context: TenantContext,
    metric: InsightTargetMetric,
  ): Promise<InsightTargetRow | undefined> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(insightTargets)
      .where(
        and(
          eq(insightTargets.organizationId, context.organizationId),
          eq(insightTargets.metric, metric),
        ),
      )
      .limit(1);
    return rows[0];
  }
}

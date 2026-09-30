import { and, asc, desc, eq } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { insightMetricAlerts, insightSnapshots } from '../../common/database/schema.js';
import type {
  InsightAlertComparator,
  InsightAlertMetric,
  InsightMetricAlertRow,
} from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * x319's data seam — the tenant-scoped, self-scoped reads and the one upsert/delete over
 * `insight_metric_alerts`, plus the read-only join to the latest `workload` snapshot the evaluation
 * needs.
 *
 * A repository is the only layer allowed a driver handle (25-AUTH-AND-TENANT-ISOLATION §6); the service
 * takes a `TenantQueryRunner` from `TenantDatabase.transaction()` / `.read()` and hands it here. Every
 * statement binds or filters `organization_id` from the context — never from input — and every alert
 * read/write also filters `member_user_id` to the caller, so an alert can never be set for, listed
 * across, read from, or deleted in another tenant, nor can a caller name another member's row. The
 * reads carry no policy: the `work.read` gate lives in the controller/service.
 */

/** The upsert shape. `organizationId`/`memberUserId` are absent — both come from the context/caller. */
export interface UpsertMetricAlertInput {
  readonly memberUserId: string;
  readonly metricKey: InsightAlertMetric;
  readonly comparator: InsightAlertComparator;
  readonly threshold: number;
}

export class InsightMetricAlertsRepository {
  /**
   * Create or replace one member's alert for one metric. A single `INSERT ... ON DUPLICATE KEY UPDATE`
   * against `uq_insight_metric_alerts_org_member_metric`, so two saves for one (member, metric)
   * serialise on the unique key rather than on a row this code read first — a lost update is not
   * expressible. The insert path fills `id`/`created_at`; the update path moves only
   * `comparator`/`threshold` (identity is pinned by the 0187 trigger).
   */
  async upsert(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: UpsertMetricAlertInput,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .insert(insightMetricAlerts)
      .values({
        id: uuidv7(),
        organizationId: context.organizationId,
        memberUserId: input.memberUserId,
        metricKey: input.metricKey,
        comparator: input.comparator,
        threshold: input.threshold,
        createdAt: new Date(),
      })
      .onDuplicateKeyUpdate({
        set: {
          comparator: input.comparator,
          threshold: input.threshold,
        },
      });
  }

  /** List the caller's own alerts in this tenant, ordered by metric. Scoped on `(org, member)`. */
  async listForMember(
    runner: TenantQueryRunner,
    context: TenantContext,
    memberUserId: string,
  ): Promise<readonly InsightMetricAlertRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(insightMetricAlerts)
      .where(
        and(
          eq(insightMetricAlerts.organizationId, context.organizationId),
          eq(insightMetricAlerts.memberUserId, memberUserId),
        ),
      )
      .orderBy(asc(insightMetricAlerts.metricKey));
  }

  /**
   * Delete one of the caller's own alerts by metric, tenant- and self-scoped on
   * `(org, member, metric)`. Idempotent: a metric the caller has no alert for — or another member's —
   * removes nothing and is not an error, so the delete is a 204 whether or not a row was present.
   */
  async deleteOwn(
    runner: TenantQueryRunner,
    context: TenantContext,
    memberUserId: string,
    metricKey: InsightAlertMetric,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .delete(insightMetricAlerts)
      .where(
        and(
          eq(insightMetricAlerts.organizationId, context.organizationId),
          eq(insightMetricAlerts.memberUserId, memberUserId),
          eq(insightMetricAlerts.metricKey, metricKey),
        ),
      );
  }

  /**
   * Fetch the latest `workload` snapshot's opaque payload for this tenant — the read-side figures the
   * evaluation marks alerts breached against. Tenant-scoped on `organization_id`; `undefined` when no
   * snapshot has been captured yet, which the service treats as "nothing to evaluate against".
   */
  async latestWorkloadPayload(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<unknown | undefined> {
    const rows = await tenantDrizzle(runner)
      .select({ payload: insightSnapshots.payloadJson })
      .from(insightSnapshots)
      .where(
        and(
          eq(insightSnapshots.organizationId, context.organizationId),
          eq(insightSnapshots.kind, 'workload'),
        ),
      )
      .orderBy(desc(insightSnapshots.capturedAt), desc(insightSnapshots.id))
      .limit(1);
    return rows[0]?.payload;
  }
}

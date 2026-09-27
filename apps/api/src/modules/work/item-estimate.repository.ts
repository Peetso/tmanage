import { and, eq, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { workItemEstimates, workItemTimeLogs } from '../../common/database/schema.js';
import type { WorkItemEstimateRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * Work item effort estimates — x258's storage half (Work module).
 *
 * Follows `WorkTimeLogsRepository`: `TenantContext` is the scoping parameter, no `organizationId` on
 * any input (it comes from the context), and every read and write is bound to `(organization_id, …)`
 * so a caller in the wrong tenant sees nothing rather than a leak. The repository holds no policy —
 * the service decides who may read and write, and the composite foreign key of migration 0128 is
 * what makes a cross-tenant `work_item_id` a non-existent pair.
 *
 * The one estimate per item is stored by upsert on `(organization_id, work_item_id)`. The *actual*
 * figure is a read-only sum over x231's `work_item_time_logs`, joined here (never written): a work
 * item with no logged time sums to zero, so the read degrades cleanly when nothing has been logged.
 */

export interface UpsertEstimateInput {
  readonly workItemId: string;
  readonly estimateMinutes: number;
}

export class WorkItemEstimateRepository {
  /** The estimate for one work item, scoped to the tenant; `null` if none has been set. */
  async find(
    runner: TenantQueryRunner,
    context: TenantContext,
    workItemId: string,
  ): Promise<WorkItemEstimateRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(workItemEstimates)
      .where(
        and(
          eq(workItemEstimates.organizationId, context.organizationId),
          eq(workItemEstimates.workItemId, workItemId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** Set or revise the single estimate for a work item. Idempotent by the org+item unique key. */
  async upsert(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: UpsertEstimateInput,
  ): Promise<WorkItemEstimateRow> {
    await tenantDrizzle(runner)
      .insert(workItemEstimates)
      .values({
        id: uuidv7(),
        // From the context. Not from `input` — there is no such field.
        organizationId: context.organizationId,
        workItemId: input.workItemId,
        estimateMinutes: input.estimateMinutes,
        createdAt: sql`current_timestamp(3)`,
        updatedAt: sql`current_timestamp(3)`,
      })
      .onDuplicateKeyUpdate({
        set: {
          estimateMinutes: input.estimateMinutes,
          updatedAt: sql`current_timestamp(3)`,
        },
      });

    // Read back so the server-generated timestamps and the persisted row are what is returned, never
    // a hand-assembled guess. Tenant-scoped, so the read cannot cross a tenant boundary.
    const saved = await this.find(runner, context, input.workItemId);
    if (!saved) {
      // Unreachable: the upsert above committed this row in this transaction.
      throw new Error('work-item estimate vanished immediately after upsert');
    }
    return saved;
  }

  /**
   * The actual logged effort for a work item: the sum of x231's time-log minutes, tenant-scoped and
   * read-only. A work item with no logged time (or before x231 has recorded any) sums to zero.
   */
  async sumLoggedMinutes(
    runner: TenantQueryRunner,
    context: TenantContext,
    workItemId: string,
  ): Promise<number> {
    const rows = await tenantDrizzle(runner)
      .select({ total: sql<string | null>`sum(${workItemTimeLogs.minutes})` })
      .from(workItemTimeLogs)
      .where(
        and(
          eq(workItemTimeLogs.organizationId, context.organizationId),
          eq(workItemTimeLogs.workItemId, workItemId),
        ),
      );
    const total = rows[0]?.total;
    return total == null ? 0 : Number(total);
  }
}

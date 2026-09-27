import { and, asc, eq, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { workItemWatchers } from '../../common/database/schema.js';
import type { WorkItemWatcherRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * Work item watchers — x232's storage half (Work module 7).
 *
 * Follows `WorkCommentsRepository`: `TenantContext` is the scoping parameter, no `organizationId`
 * on any input type (it comes from the context), and every read and write is bound to
 * `(organization_id, …)` so a caller in the wrong tenant sees nothing rather than a leak. The
 * repository holds no policy — the service decides who may read or write, and the composite
 * foreign key of migration 0104 is what makes a cross-tenant `work_item_id` a non-existent pair.
 *
 * Unlike the append-only comments, a watch is removable: this repository inserts, reads and
 * deletes, mirroring the INSERT + DELETE grant in `users.sql`. The unique
 * `(organization_id, work_item_id, member_id)` key is what makes a repeated subscribe idempotent —
 * the service finds the existing row rather than inserting a duplicate.
 */

/** The largest watcher page a single read returns; mirrors the bounded reads elsewhere. */
export const MAX_WATCHER_PAGE = 500;

export interface CreateWatcherInput {
  readonly workItemId: string;
  readonly memberId: string;
}

export class WorkWatchersRepository {
  /** One member's watch on one item, scoped to the tenant; `null` if absent. */
  async findForMember(
    runner: TenantQueryRunner,
    context: TenantContext,
    workItemId: string,
    memberId: string,
  ): Promise<WorkItemWatcherRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(workItemWatchers)
      .where(
        and(
          eq(workItemWatchers.organizationId, context.organizationId),
          eq(workItemWatchers.workItemId, workItemId),
          eq(workItemWatchers.memberId, memberId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** The item's watchers, created-at ascending then id, bounded to one page. */
  async listForWorkItem(
    runner: TenantQueryRunner,
    context: TenantContext,
    workItemId: string,
    limit: number = MAX_WATCHER_PAGE,
  ): Promise<readonly WorkItemWatcherRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(workItemWatchers)
      .where(
        and(
          eq(workItemWatchers.organizationId, context.organizationId),
          eq(workItemWatchers.workItemId, workItemId),
        ),
      )
      .orderBy(asc(workItemWatchers.createdAt), asc(workItemWatchers.id))
      .limit(Math.min(Math.max(1, Math.trunc(limit)), MAX_WATCHER_PAGE));
  }

  /** Insert a watch. The server timestamp is read back rather than reconstructed. */
  async create(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: CreateWatcherInput,
  ): Promise<WorkItemWatcherRow> {
    const id = uuidv7();
    await tenantDrizzle(runner)
      .insert(workItemWatchers)
      .values({
        id,
        organizationId: context.organizationId,
        workItemId: input.workItemId,
        memberId: input.memberId,
        createdAt: sql`current_timestamp(3)`,
      });
    const created = await this.findForMember(runner, context, input.workItemId, input.memberId);
    if (!created) {
      // Unreachable: the insert above committed this row in this transaction.
      throw new Error('work item watcher vanished immediately after insert');
    }
    return created;
  }

  /** Remove one member's watch on one item, scoped to the tenant. Idempotent — a no-op if absent. */
  async deleteForMember(
    runner: TenantQueryRunner,
    context: TenantContext,
    workItemId: string,
    memberId: string,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .delete(workItemWatchers)
      .where(
        and(
          eq(workItemWatchers.organizationId, context.organizationId),
          eq(workItemWatchers.workItemId, workItemId),
          eq(workItemWatchers.memberId, memberId),
        ),
      );
  }
}

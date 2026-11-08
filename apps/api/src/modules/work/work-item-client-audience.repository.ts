import { and, eq, exists, notExists, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import {
  clientMemberships,
  workItemClientAudience,
  workItems,
} from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * C25 (0317) — which of a project's client companies may see a client-facing work item.
 *
 * `work_item_client_audience` holds the companies an item is narrowed to. **No rows means every
 * client company the project is shared with**, which is what every item written before 0317
 * means, so nothing existing changes.
 *
 * ## Enforced where the rows are read
 *
 * {@link clientAudienceVisible} is a SQL predicate on `work_items`, applied by
 * `WorkItemsRepository` (list, findById, findManyByIds) and the search reads whenever the acting
 * context is a **client** principal. Every client path to a work item — the portal work list, the
 * work-item read, its comments, files, checklist and the rest of the sub-resources, the timeline,
 * workload and calendar views, search and suggestions — goes through one of those reads, so a
 * client company that is not listed gets the same "absent" an internal item gives (a 404 where
 * one row was asked for). The client is identified by the context's client membership, joined to
 * its client company inside the same organization; an internal or service context is untouched.
 */
export function clientAudienceVisible(context: TenantContext): SQL | undefined {
  if (context.principalKind !== 'client') return undefined;
  const a = workItemClientAudience;
  return or(
    notExists(
      sql`(select 1 from ${a} where ${a.organizationId} = ${context.organizationId}
        and ${a.organizationId} = ${workItems.organizationId}
        and ${a.workItemId} = ${workItems.id})`,
    ),
    exists(
      sql`(select 1 from ${a} inner join ${clientMemberships}
        on ${clientMemberships.organizationId} = ${a.organizationId}
        and ${clientMemberships.clientOrganizationId} = ${a.clientOrganizationId}
        where ${a.organizationId} = ${context.organizationId}
        and ${a.organizationId} = ${workItems.organizationId}
        and ${a.workItemId} = ${workItems.id}
        and ${clientMemberships.id} = ${context.membershipId})`,
    ),
  );
}

/** Storage for `work_item_client_audience`. Every statement carries the tenant key. */
export class WorkItemClientAudienceRepository {
  async list(
    runner: TenantQueryRunner,
    context: TenantContext,
    workItemId: string,
  ): Promise<readonly string[]> {
    const rows = await tenantDrizzle(runner)
      .select({ clientOrganizationId: workItemClientAudience.clientOrganizationId })
      .from(workItemClientAudience)
      .where(
        and(
          eq(workItemClientAudience.organizationId, context.organizationId),
          eq(workItemClientAudience.workItemId, workItemId),
        ),
      );
    return rows.map((row) => row.clientOrganizationId);
  }

  /** Replace the item's list as a set. `[]` clears it, which means every project client. */
  async replace(
    runner: TenantQueryRunner,
    context: TenantContext,
    workItemId: string,
    clientOrganizationIds: readonly string[],
  ): Promise<void> {
    await this.clear(runner, context, workItemId);
    if (clientOrganizationIds.length === 0) return;
    const createdAt = new Date();
    await tenantDrizzle(runner)
      .insert(workItemClientAudience)
      .values(
        clientOrganizationIds.map((clientOrganizationId) => ({
          organizationId: context.organizationId,
          workItemId,
          clientOrganizationId,
          createdAt,
        })),
      );
  }

  async clear(
    runner: TenantQueryRunner,
    context: TenantContext,
    workItemId: string,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .delete(workItemClientAudience)
      .where(
        and(
          eq(workItemClientAudience.organizationId, context.organizationId),
          eq(workItemClientAudience.workItemId, workItemId),
        ),
      );
  }
}

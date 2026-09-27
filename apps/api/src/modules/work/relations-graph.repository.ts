import { and, eq, inArray, or } from 'drizzle-orm';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { workItemLinks } from '../../common/database/schema.js';
import type { WorkItemLinkRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * x274's storage — the read side of `work_item_links` (x204) for a work item's relations graph.
 *
 * There is no new table: this repository only *reads* the links x204 already owns, and it never
 * writes. It holds no policy — the service decides which items the caller may see — and, like every
 * repository here, it takes the `TenantQueryRunner` and `TenantContext` first and carries the tenant
 * predicate on every statement, so a link touching another studio's item is never selected.
 */

/** The largest set of links one BFS expansion loads. A studio's dependency graph is small. */
export const MAX_GRAPH_LINKS = 2000;

/** One undirected-in-storage typed link, as the graph walk consumes it. */
export interface RelationLinkRow {
  readonly fromWorkItemId: string;
  readonly toWorkItemId: string;
  readonly linkType: WorkItemLinkRow['linkType'];
}

export class WorkRelationsGraphRepository {
  /**
   * Every link in the acting tenant that touches any of `workItemIds` on either end — the frontier
   * expansion of the breadth-first walk. Both `from_work_item_id` and `to_work_item_id` are matched
   * so an item's relations are found whichever direction the link was authored in. An empty id set
   * returns nothing without a query; the result is capped at {@link MAX_GRAPH_LINKS}.
   */
  async listLinksTouching(
    runner: TenantQueryRunner,
    context: TenantContext,
    workItemIds: readonly string[],
    limit: number = MAX_GRAPH_LINKS,
  ): Promise<readonly RelationLinkRow[]> {
    if (workItemIds.length === 0) return [];
    const ids = [...workItemIds];
    const rows = await tenantDrizzle(runner)
      .select({
        fromWorkItemId: workItemLinks.fromWorkItemId,
        toWorkItemId: workItemLinks.toWorkItemId,
        linkType: workItemLinks.linkType,
      })
      .from(workItemLinks)
      .where(
        and(
          eq(workItemLinks.organizationId, context.organizationId),
          or(inArray(workItemLinks.fromWorkItemId, ids), inArray(workItemLinks.toWorkItemId, ids)),
        ),
      )
      .limit(Math.min(Math.max(1, Math.trunc(limit)), MAX_GRAPH_LINKS));
    return rows;
  }
}

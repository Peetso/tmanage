import { and, asc, eq, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { workItemLinks, workItems } from '../../common/database/schema.js';
import type { WorkItemLinkRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * The work-item links repository — x204 (Work module 7), following the `decision_work_links` /
 * `work_item_dependencies` shape.
 *
 * `25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md` §6 is honoured structurally: every method takes
 * the `TenantQueryRunner` and the `TenantContext` first, no input type carries an `organizationId`
 * (the tenant comes from the context, never the DTO), and every statement carries the tenant
 * predicate. The repository holds no policy — the service decides who may read or write — and the
 * composite foreign keys of migration 0085 are what make a cross-tenant end a non-existent pair.
 */

/** The largest link page a single read returns; mirrors the bounded reads elsewhere. */
export const MAX_LINK_PAGE = 500;

/** The largest blocking-graph a single cycle walk loads. A studio's dependency graph is small. */
export const MAX_BLOCKING_EDGES = 5000;

export interface CreateWorkItemLinkInput {
  readonly fromWorkItemId: string;
  readonly toWorkItemId: string;
  readonly linkType: 'blocks' | 'blocked_by' | 'relates';
  /** The person who created the link — the service passes `context.userId`. */
  readonly createdByUserId: string;
}

/** A link joined to the work item it points at, for the list projection. */
export interface WorkItemLinkWithTarget {
  readonly link: WorkItemLinkRow;
  readonly toWorkItemTitle: string;
  readonly toWorkItemState: string;
}

/** One directed blocking edge, normalized to blocker → blocked, for the cycle walk. */
export interface BlockingEdge {
  readonly blocker: string;
  readonly blocked: string;
}

export class WorkItemLinksRepository {
  /**
   * One link's set authored on an item (`from_work_item_id`), within the acting tenant, joined to
   * each target work item so the caller can render a title and state without a second query. The
   * join is on the composite `(organization_id, id)` so it never crosses a tenant; the order is
   * `created_at ASC, id ASC` — oldest first, UUIDv7 id as the deterministic tiebreaker.
   */
  async listFromItem(
    runner: TenantQueryRunner,
    context: TenantContext,
    fromWorkItemId: string,
    limit: number = MAX_LINK_PAGE,
  ): Promise<readonly WorkItemLinkWithTarget[]> {
    const rows = await tenantDrizzle(runner)
      .select({ link: workItemLinks, title: workItems.title, state: workItems.state })
      .from(workItemLinks)
      .innerJoin(
        workItems,
        and(
          eq(workItems.organizationId, workItemLinks.organizationId),
          eq(workItems.id, workItemLinks.toWorkItemId),
        ),
      )
      .where(
        and(
          eq(workItemLinks.organizationId, context.organizationId),
          eq(workItemLinks.fromWorkItemId, fromWorkItemId),
        ),
      )
      .orderBy(asc(workItemLinks.createdAt), asc(workItemLinks.id))
      .limit(Math.min(Math.max(1, Math.trunc(limit)), MAX_LINK_PAGE));

    return rows.map((row) => ({
      link: row.link,
      toWorkItemTitle: row.title,
      toWorkItemState: row.state,
    }));
  }

  /** Fetch one link by id, within the acting tenant; `null` if absent or cross-tenant. */
  async findById(
    runner: TenantQueryRunner,
    context: TenantContext,
    linkId: string,
  ): Promise<WorkItemLinkRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(workItemLinks)
      .where(
        and(eq(workItemLinks.organizationId, context.organizationId), eq(workItemLinks.id, linkId)),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** True when this exact typed edge already exists in the tenant — the duplicate pre-check. */
  async edgeExists(
    runner: TenantQueryRunner,
    context: TenantContext,
    fromWorkItemId: string,
    toWorkItemId: string,
    linkType: 'blocks' | 'blocked_by' | 'relates',
  ): Promise<boolean> {
    const rows = await tenantDrizzle(runner)
      .select({ id: workItemLinks.id })
      .from(workItemLinks)
      .where(
        and(
          eq(workItemLinks.organizationId, context.organizationId),
          eq(workItemLinks.fromWorkItemId, fromWorkItemId),
          eq(workItemLinks.toWorkItemId, toWorkItemId),
          eq(workItemLinks.linkType, linkType),
        ),
      )
      .limit(1);
    return rows[0] !== undefined;
  }

  /**
   * All of the tenant's `blocks` / `blocked_by` links, normalized to a directed blocker → blocked
   * edge, for the service's cycle walk. `blocks` keeps its direction (from blocks to); `blocked_by`
   * is reversed (from is blocked by to ⇒ to blocks from). `relates` is undirected and excluded.
   */
  async listBlockingEdges(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<readonly BlockingEdge[]> {
    const rows = await tenantDrizzle(runner)
      .select({
        from: workItemLinks.fromWorkItemId,
        to: workItemLinks.toWorkItemId,
        type: workItemLinks.linkType,
      })
      .from(workItemLinks)
      .where(eq(workItemLinks.organizationId, context.organizationId))
      .limit(MAX_BLOCKING_EDGES);

    const edges: BlockingEdge[] = [];
    for (const row of rows) {
      if (row.type === 'blocks') edges.push({ blocker: row.from, blocked: row.to });
      else if (row.type === 'blocked_by') edges.push({ blocker: row.to, blocked: row.from });
    }
    return edges;
  }

  /**
   * Create a link. `organization_id` comes from the context, never from `input`. Read back so the
   * caller gets the server-generated timestamp. The `uq_work_item_links_edge` unique key is the
   * backstop for a duplicate the service's pre-check cannot see under a race; the composite foreign
   * keys refuse an end from another tenant.
   */
  async create(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: CreateWorkItemLinkInput,
  ): Promise<WorkItemLinkRow> {
    const id = uuidv7();
    await tenantDrizzle(runner)
      .insert(workItemLinks)
      .values({
        id,
        organizationId: context.organizationId,
        fromWorkItemId: input.fromWorkItemId,
        toWorkItemId: input.toWorkItemId,
        linkType: input.linkType,
        createdByUserId: input.createdByUserId,
        createdAt: sql`current_timestamp(3)`,
      });

    const created = await this.findById(runner, context, id);
    if (!created) {
      // Unreachable: the insert above committed this row in this transaction.
      throw new Error('work item link vanished immediately after insert');
    }
    return created;
  }

  /**
   * Remove a link by id, within the acting tenant. The predicate carries both `organization_id`
   * and `id`, so a cross-tenant id deletes nothing — the service resolves the id tenant-scoped
   * first and returns a 404 for an unknown or cross-tenant link.
   */
  async deleteById(
    runner: TenantQueryRunner,
    context: TenantContext,
    linkId: string,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .delete(workItemLinks)
      .where(
        and(eq(workItemLinks.organizationId, context.organizationId), eq(workItemLinks.id, linkId)),
      );
  }
}

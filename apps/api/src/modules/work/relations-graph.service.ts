import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import type { WorkItemLinkRow, WorkItemRow } from '../../common/database/schema.js';
import type { WorkItemsRepository } from './work-items.repository.js';
import { WorkRelationsGraphRepository } from './relations-graph.repository.js';

/**
 * x274's application service — a read-only adjacency view of a work item's typed relations
 * (`blocks` / `blocked_by` / `relates`) for a dependency map. Module map §Work ("dependencies").
 *
 * It reads x204's `work_item_links` and writes nothing. The shape is the sibling read services':
 * the controller holds no policy, the repository holds none, and the two rules that matter live
 * here.
 *
 * ## The root is resolved tenant-scoped BEFORE anything is disclosed
 *
 * The path item is read first, tenant-scoped, and refused with the ordinary 404 if it is absent,
 * soft-deleted or the caller may not read it (same 404 the work-item read gives). No link is read
 * and no node is built until the root is in hand, so a graph request for another studio's item
 * leaks nothing — not even that the item exists.
 *
 * ## Only items the caller can read enter the graph
 *
 * The walk is a bounded breadth-first expansion (depth 1..3, default 1) over the tenant's links.
 * Each candidate neighbour is resolved tenant-scoped and kept only if it is live and readable by
 * this principal; an unreadable or soft-deleted neighbour is neither a node nor walked past. Edges
 * are emitted last, and only when *both* endpoints are readable nodes, so no edge can point at an
 * item the caller was never allowed to see. A `visited` set makes the walk terminate over cyclic
 * data.
 */

/** The maximum walk depth a request may ask for. */
export const MAX_RELATIONS_GRAPH_DEPTH = 3;
/** The walk depth used when the request names none. */
export const DEFAULT_RELATIONS_GRAPH_DEPTH = 1;

/** One work item in the graph, with its distance from the root. */
export interface RelationGraphNode {
  readonly workItemId: string;
  readonly title: string;
  readonly state: string;
  /** Breadth-first distance from the root; 0 is the root itself. */
  readonly depth: number;
  readonly isRoot: boolean;
}

/** One typed edge between two nodes, in the direction it was authored. */
export interface RelationGraphEdge {
  readonly fromWorkItemId: string;
  readonly toWorkItemId: string;
  readonly linkType: WorkItemLinkRow['linkType'];
}

/** The client-facing projection of the whole graph. Paired in `e2e/contracts`. */
export interface WorkRelationsGraphView {
  readonly rootId: string;
  /** The effective depth the walk used (after defaulting). */
  readonly depth: number;
  readonly nodes: readonly RelationGraphNode[];
  readonly edges: readonly RelationGraphEdge[];
}

export class WorkRelationsGraphService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly workItems: WorkItemsRepository,
    private readonly links: WorkRelationsGraphRepository = new WorkRelationsGraphRepository(),
  ) {}

  /**
   * The relations graph rooted at `workItemId`, walked to `depth`. Behind `work.read` on the root.
   * `depth` has already been validated by the controller to be an integer in `1..MAX`; it defaults
   * to {@link DEFAULT_RELATIONS_GRAPH_DEPTH} when the request names none.
   */
  async graph(
    context: TenantContext,
    principal: Principal,
    workItemId: string,
    depth: number = DEFAULT_RELATIONS_GRAPH_DEPTH,
  ): Promise<WorkRelationsGraphView> {
    return this.database.read(context, async (runner) => {
      const root = await this.readableItem(runner, context, principal, workItemId);

      const nodes = new Map<string, RelationGraphNode>();
      nodes.set(root.id, toNode(root, 0, true));

      const visited = new Set<string>([root.id]);
      let frontier: string[] = [root.id];

      for (let level = 1; level <= depth && frontier.length > 0; level += 1) {
        const touching = await this.links.listLinksTouching(runner, context, frontier);

        // The endpoints on the far side of a frontier link that have not yet been seen.
        const frontierSet = new Set(frontier);
        const candidates = new Set<string>();
        for (const link of touching) {
          if (frontierSet.has(link.fromWorkItemId) && !visited.has(link.toWorkItemId)) {
            candidates.add(link.toWorkItemId);
          }
          if (frontierSet.has(link.toWorkItemId) && !visited.has(link.fromWorkItemId)) {
            candidates.add(link.fromWorkItemId);
          }
        }
        if (candidates.size === 0) break;

        const rows = await this.workItems.findManyByIds(runner, context, [...candidates]);
        const readable = new Map(rows.map((row) => [row.id, row]));

        const next: string[] = [];
        for (const id of candidates) {
          // Every candidate is marked visited — even an unreadable or absent one — so the walk
          // never revisits it, but only a live, readable item becomes a node and is walked past.
          visited.add(id);
          const row = readable.get(id);
          if (!row || row.deletedAt !== null || !this.mayRead(principal, row)) continue;
          nodes.set(id, toNode(row, level, false));
          next.push(id);
        }
        frontier = next;
      }

      const edges = await this.collectEdges(runner, context, nodes);
      return {
        rootId: root.id,
        depth,
        nodes: [...nodes.values()],
        edges,
      };
    });
  }

  /**
   * Every distinct typed link both of whose endpoints are nodes in the graph. Reading the links
   * that touch the node set and then keeping only the intra-set ones guarantees no edge points at
   * an item the caller could not read — an unreadable neighbour was never added as a node.
   */
  private async collectEdges(
    runner: TenantQueryRunner,
    context: TenantContext,
    nodes: ReadonlyMap<string, RelationGraphNode>,
  ): Promise<readonly RelationGraphEdge[]> {
    const touching = await this.links.listLinksTouching(runner, context, [...nodes.keys()]);
    const edges: RelationGraphEdge[] = [];
    const seen = new Set<string>();
    for (const link of touching) {
      if (!nodes.has(link.fromWorkItemId) || !nodes.has(link.toWorkItemId)) continue;
      const key = `${link.fromWorkItemId}|${link.toWorkItemId}|${link.linkType}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({
        fromWorkItemId: link.fromWorkItemId,
        toWorkItemId: link.toWorkItemId,
        linkType: link.linkType,
      });
    }
    return edges;
  }

  /**
   * Read the root work item, tenant-scoped, and refuse a caller who may not read it with the
   * ordinary 404 — the same one the work-item read produces for a row that does not exist.
   */
  private async readableItem(
    runner: TenantQueryRunner,
    context: TenantContext,
    principal: Principal,
    workItemId: string,
  ): Promise<WorkItemRow> {
    const row = await this.workItems.findById(runner, context, workItemId);
    if (!row || row.deletedAt !== null || !this.mayRead(principal, row)) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound);
    }
    return row;
  }

  private mayRead(principal: Principal, row: WorkItemRow): boolean {
    return authorize({ principal, capability: 'work.read', resource: resourceOf(row) }).allowed;
  }
}

function resourceOf(row: WorkItemRow) {
  return {
    organizationId: row.organizationId,
    projectId: row.projectId,
    audience: row.audience,
    lifecycle: row.deletedAt
      ? ('soft_deleted' as const)
      : row.state === 'archived'
        ? ('archived' as const)
        : ('active' as const),
  };
}

function toNode(row: WorkItemRow, depth: number, isRoot: boolean): RelationGraphNode {
  return {
    workItemId: row.id,
    title: row.title,
    state: row.state,
    depth,
    isRoot,
  };
}

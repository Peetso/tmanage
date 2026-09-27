import type { ApiClient } from './client';
import type { WorkItemLinkType } from './work-items';

/**
 * The work-item relations graph endpoint — x274, gated on `work.read`. A read-only adjacency view
 * of a work item's typed links (`blocks` / `blocked_by` / `relates`) for a dependency map, walked
 * breadth-first to a bounded depth from the root item.
 *
 * - **One item's neighbourhood.** `GET …/work-items/:id/relations/graph?depth=` returns the root,
 *   the items reachable within `depth` (1..3, default 1) that the caller may read, and the typed
 *   edges between them. It writes nothing.
 * - **Authorization is the API's.** The root and every neighbour are resolved tenant-scoped; an
 *   item the caller cannot read is neither a node nor an endpoint of an edge, and a cross-tenant or
 *   absent root is the ordinary 404.
 */

/** One work item in the graph, with its breadth-first distance from the root (0 is the root). */
interface RelationGraphNode {
  readonly workItemId: string;
  readonly title: string;
  readonly state: string;
  readonly depth: number;
  readonly isRoot: boolean;
}

/** One typed edge between two nodes, in the direction the link was authored. */
interface RelationGraphEdge {
  readonly fromWorkItemId: string;
  readonly toWorkItemId: string;
  readonly linkType: WorkItemLinkType;
}

export interface WorkRelationsGraph {
  readonly rootId: string;
  /** The effective depth the walk used. */
  readonly depth: number;
  readonly nodes: readonly RelationGraphNode[];
  readonly edges: readonly RelationGraphEdge[];
}

export async function fetchWorkRelationsGraph(
  client: ApiClient,
  organizationSlug: string,
  workItemId: string,
  query: { readonly depth?: number } = {},
): Promise<WorkRelationsGraph> {
  const parameters = new URLSearchParams();
  if (query.depth !== undefined) parameters.set('depth', String(query.depth));
  const suffix = parameters.toString() === '' ? '' : `?${parameters.toString()}`;

  const { data } = await client.request<WorkRelationsGraph>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/work-items/${encodeURIComponent(workItemId)}/relations/graph${suffix}`,
  });
  return data;
}

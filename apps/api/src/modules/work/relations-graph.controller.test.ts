import { beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { WorkRelationsGraphController } from './relations-graph.controller.js';
import { WorkRelationsGraphService } from './relations-graph.service.js';
import type { WorkItemsRepository } from './work-items.repository.js';
import { ApiError } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { WorkItemRow } from '../../common/database/schema.js';
import type { RelationLinkRow } from './relations-graph.repository.js';

/**
 * x274 — the database-free proof of the read-only relations graph. It runs the controller over an
 * in-memory link store and a fake work-item lookup with the **real** `authorize`. The behaviours a
 * wiring bug would break are proved here: resolve-root-then-read, the cross-tenant 404 that leaks
 * no rows, the depth bound, cycle termination, and that an unreadable neighbour is neither a node
 * nor an edge. The composite foreign keys and the actual SQL are the chain's DB suite's, not here.
 */

const ORG = '01890000-0000-7000-8000-00000000000a';
const PROJECT = '01890000-0000-7000-8000-000000000101';
const OTHER_PROJECT = '01890000-0000-7000-8000-000000000102';
const A = '01890000-0000-7000-8000-000000000201';
const B = '01890000-0000-7000-8000-000000000202';
const C = '01890000-0000-7000-8000-000000000203';

const context = {
  organizationId: ORG,
  userId: '01890000-0000-7000-8000-000000000001',
} as TenantContext;

function member(projectIds: readonly string[]): Principal {
  return {
    userId: '01890000-0000-7000-8000-000000000001',
    organizationId: ORG,
    kind: 'internal',
    role: 'member',
    membershipId: '01890000-0000-7000-8000-000000000011',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds,
    hasOrgWideScope: false,
  };
}

function workItem(id: string, over: Partial<WorkItemRow> = {}): WorkItemRow {
  const now = new Date();
  return {
    id,
    organizationId: ORG,
    projectId: PROJECT,
    type: 'task',
    title: `Item ${id.slice(-3)}`,
    state: 'in_progress',
    ownerUserId: null,
    audience: 'internal',
    startAt: null,
    dueAt: null,
    completedAt: null,
    version: 1,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    deletedByUserId: null,
    deletedReason: null,
    purgeAfter: null,
    ...over,
  };
}

/** An in-memory link store standing in for the repository, counting reads to prove none leak. */
class FakeLinksRepository {
  reads = 0;
  constructor(private readonly edges: readonly RelationLinkRow[] = []) {}

  async listLinksTouching(
    _r: unknown,
    _c: TenantContext,
    ids: readonly string[],
  ): Promise<readonly RelationLinkRow[]> {
    this.reads += 1;
    const set = new Set(ids);
    return this.edges.filter((e) => set.has(e.fromWorkItemId) || set.has(e.toWorkItemId));
  }
}

function harness(items: readonly WorkItemRow[], edges: readonly RelationLinkRow[] = []) {
  const byId = new Map(items.map((i) => [i.id, i]));
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const workItems = {
    findById: async (_r: unknown, _c: unknown, id: string) => byId.get(id) ?? null,
    findManyByIds: async (_r: unknown, _c: unknown, ids: readonly string[]) =>
      ids.map((id) => byId.get(id)).filter((row): row is WorkItemRow => row !== undefined),
  } as unknown as WorkItemsRepository;
  const links = new FakeLinksRepository(edges);
  const service = new WorkRelationsGraphService(
    database,
    workItems,
    links as unknown as ConstructorParameters<typeof WorkRelationsGraphService>[2],
  );
  return { controller: new WorkRelationsGraphController(service), links };
}

async function statusOf(work: () => Promise<unknown>): Promise<number> {
  try {
    await work();
  } catch (error) {
    if (error instanceof ApiError) return error.status;
    throw error;
  }
  throw new Error('expected the call to throw');
}

describe('WorkRelationsGraphController', () => {
  const related = member([PROJECT]);
  let edges: RelationLinkRow[];

  beforeEach(() => {
    edges = [
      { fromWorkItemId: A, toWorkItemId: B, linkType: 'blocks' },
      { fromWorkItemId: C, toWorkItemId: A, linkType: 'relates' },
      { fromWorkItemId: B, toWorkItemId: A, linkType: 'blocked_by' }, // a cycle back to the root
    ];
  });

  it('builds the adjacency graph at the default depth, root first', async () => {
    const { controller } = harness([workItem(A), workItem(B), workItem(C)], edges);
    const graph = await controller.graph(context, related, A);
    expect(graph).toMatchObject({ rootId: A, depth: 1 });
    expect(graph.nodes.map((n) => n.workItemId).sort()).toEqual([A, B, C].sort());
    expect(graph.nodes.find((n) => n.workItemId === A)?.isRoot).toBe(true);
    // Every edge's endpoints are nodes; the cycle back to the root did not loop forever.
    for (const edge of graph.edges) {
      expect(graph.nodes.some((n) => n.workItemId === edge.fromWorkItemId)).toBe(true);
      expect(graph.nodes.some((n) => n.workItemId === edge.toWorkItemId)).toBe(true);
    }
    expect(graph.edges).toHaveLength(3);
  });

  it('answers 404 for a cross-tenant or absent root and reads no links', async () => {
    // The root is not in this tenant's item store: the graph must refuse before touching links.
    const { controller, links } = harness([workItem(B), workItem(C)], edges);
    expect(await statusOf(() => controller.graph(context, related, A))).toBe(404);
    expect(links.reads).toBe(0);
  });

  it('rejects a depth outside 1..3 with 400', async () => {
    const { controller } = harness([workItem(A)], []);
    expect(await statusOf(() => controller.graph(context, related, A, '0'))).toBe(400);
    expect(await statusOf(() => controller.graph(context, related, A, '4'))).toBe(400);
    expect(await statusOf(() => controller.graph(context, related, A, 'abc'))).toBe(400);
  });

  it('omits an unreadable neighbour: neither a node nor an edge', async () => {
    // C is in a project the caller is not a member of, so it is invisible; the A→C edge drops.
    const { controller } = harness(
      [workItem(A), workItem(B), workItem(C, { projectId: OTHER_PROJECT })],
      edges,
    );
    const graph = await controller.graph(context, related, A);
    expect(graph.nodes.some((n) => n.workItemId === C)).toBe(false);
    expect(graph.edges.some((e) => e.fromWorkItemId === C || e.toWorkItemId === C)).toBe(false);
  });
});

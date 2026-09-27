import { beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { WorkItemLinksController } from './item-links.controller.js';
import { WorkItemLinksService, wouldCycle } from './item-links.service.js';
import type { WorkItemsRepository } from './work-items.repository.js';
import { ApiError } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { WorkItemLinkRow, WorkItemRow } from '../../common/database/schema.js';
import type { BlockingEdge, WorkItemLinkWithTarget } from './item-links.repository.js';

/**
 * x204 — the database-free proof of the work-item links sub-resource. It runs the controller over
 * an in-memory link store and a fake work-item lookup, with the **real** `authorize`: the
 * resolve-both-ends-then-authorize order, the four create refusals (self-link / duplicate / cycle /
 * 403-vs-404) and the cross-tenant target 404 are the behaviours a wiring bug would break, and none
 * needs MySQL. The composite foreign keys and the immutability trigger are proved by the chain's DB
 * suite, not here.
 */

const ORG = '01890000-0000-7000-8000-00000000000a';
const PROJECT = '01890000-0000-7000-8000-000000000101';
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
    ...over,
  };
}

/** An in-memory link store standing in for the repository, mirroring its normalization. */
class FakeLinksRepository {
  readonly rows: WorkItemLinkRow[] = [];
  creates = 0;
  deletes = 0;

  async listFromItem(
    _r: unknown,
    _c: TenantContext,
    from: string,
  ): Promise<readonly WorkItemLinkWithTarget[]> {
    return this.rows
      .filter((r) => r.fromWorkItemId === from)
      .map((link) => ({
        link,
        toWorkItemTitle: `Item ${link.toWorkItemId.slice(-3)}`,
        toWorkItemState: 'in_progress',
      }));
  }

  async findById(_r: unknown, _c: TenantContext, id: string): Promise<WorkItemLinkRow | null> {
    return this.rows.find((r) => r.id === id) ?? null;
  }

  async edgeExists(
    _r: unknown,
    _c: TenantContext,
    from: string,
    to: string,
    type: string,
  ): Promise<boolean> {
    return this.rows.some(
      (r) => r.fromWorkItemId === from && r.toWorkItemId === to && r.linkType === type,
    );
  }

  async listBlockingEdges(): Promise<readonly BlockingEdge[]> {
    const edges: BlockingEdge[] = [];
    for (const r of this.rows) {
      if (r.linkType === 'blocks')
        edges.push({ blocker: r.fromWorkItemId, blocked: r.toWorkItemId });
      else if (r.linkType === 'blocked_by')
        edges.push({ blocker: r.toWorkItemId, blocked: r.fromWorkItemId });
    }
    return edges;
  }

  async create(
    _r: unknown,
    _c: TenantContext,
    input: {
      fromWorkItemId: string;
      toWorkItemId: string;
      linkType: 'blocks' | 'blocked_by' | 'relates';
    },
  ): Promise<WorkItemLinkRow> {
    this.creates += 1;
    const row: WorkItemLinkRow = {
      id: `link-${this.rows.length + 1}`,
      organizationId: ORG,
      fromWorkItemId: input.fromWorkItemId,
      toWorkItemId: input.toWorkItemId,
      linkType: input.linkType,
      createdByUserId: context.userId,
      createdAt: new Date(),
    };
    this.rows.push(row);
    return row;
  }

  async deleteById(_r: unknown, _c: TenantContext, id: string): Promise<void> {
    this.deletes += 1;
    const at = this.rows.findIndex((r) => r.id === id);
    if (at >= 0) this.rows.splice(at, 1);
  }
}

function harness(items: readonly WorkItemRow[]) {
  const byId = new Map(items.map((i) => [i.id, i]));
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const workItems = {
    findById: async (_r: unknown, _c: unknown, id: string) => byId.get(id) ?? null,
  } as unknown as WorkItemsRepository;
  const links = new FakeLinksRepository();
  const service = new WorkItemLinksService(
    database,
    workItems,
    links as unknown as ConstructorParameters<typeof WorkItemLinksService>[2],
  );
  return { controller: new WorkItemLinksController(service), links };
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

describe('WorkItemLinksController', () => {
  let harnessed: ReturnType<typeof harness>;
  const related = member([PROJECT]);

  beforeEach(() => {
    harnessed = harness([workItem(A), workItem(B), workItem(C)]);
  });

  it('creates, lists and removes a typed link for a related member', async () => {
    const { controller, links } = harnessed;

    const created = await controller.create(context, related, A, {
      toWorkItemId: B,
      linkType: 'blocks',
    });
    expect(created).toMatchObject({ fromWorkItemId: A, toWorkItemId: B, linkType: 'blocks' });

    const listed = await controller.list(context, related, A);
    expect(listed.links).toHaveLength(1);
    expect(listed.links[0]).toMatchObject({ id: created.id, toWorkItemState: 'in_progress' });

    await controller.remove(context, related, A, created.id);
    expect(links.deletes).toBe(1);
    expect((await controller.list(context, related, A)).links).toHaveLength(0);
  });

  it('rejects a self-link with 400 and writes nothing', async () => {
    const { controller, links } = harnessed;
    expect(
      await statusOf(() =>
        controller.create(context, related, A, { toWorkItemId: A, linkType: 'relates' }),
      ),
    ).toBe(400);
    expect(links.creates).toBe(0);
  });

  it('rejects a duplicate typed edge with 400', async () => {
    const { controller } = harnessed;
    await controller.create(context, related, A, { toWorkItemId: B, linkType: 'relates' });
    expect(
      await statusOf(() =>
        controller.create(context, related, A, { toWorkItemId: B, linkType: 'relates' }),
      ),
    ).toBe(400);
  });

  it('rejects a blocking cycle with 400', async () => {
    const { controller, links } = harnessed;
    // A blocks B, B blocks C, then C blocks A would close the loop.
    await controller.create(context, related, A, { toWorkItemId: B, linkType: 'blocks' });
    await controller.create(context, related, B, { toWorkItemId: C, linkType: 'blocks' });
    expect(
      await statusOf(() =>
        controller.create(context, related, C, { toWorkItemId: A, linkType: 'blocks' }),
      ),
    ).toBe(400);
    expect(links.creates).toBe(2);
    // The inverse type reaching the same loop is refused too: A blocked_by C means C blocks A.
    expect(
      await statusOf(() =>
        controller.create(context, related, A, { toWorkItemId: C, linkType: 'blocked_by' }),
      ),
    ).toBe(400);
  });

  it('answers 404 for a cross-tenant or absent target and writes nothing', async () => {
    const { controller, links } = harnessed;
    const status = await statusOf(() =>
      controller.create(context, related, A, {
        toWorkItemId: '01890000-0000-7000-8000-0000000009ff',
        linkType: 'relates',
      }),
    );
    expect(status).toBe(404);
    expect(links.creates).toBe(0);
  });

  it('answers 404 when the path work item is cross-tenant or absent', async () => {
    const { controller } = harness([workItem(B)]);
    expect(await statusOf(() => controller.list(context, related, A))).toBe(404);
  });

  it('refuses the write with 403 when the caller may read the item but not update it', async () => {
    // An archived item permits an internal read for history but denies every write.
    const { controller, links } = harness([workItem(A, { state: 'archived' }), workItem(B)]);
    const status = await statusOf(() =>
      controller.create(context, related, A, { toWorkItemId: B, linkType: 'relates' }),
    );
    expect(status).toBe(403);
    expect(links.creates).toBe(0);
  });

  it('wouldCycle detects a closing edge and passes an acyclic one', () => {
    const edges: BlockingEdge[] = [{ blocker: A, blocked: B }];
    expect(wouldCycle(edges, { blocker: B, blocked: A })).toBe(true);
    expect(wouldCycle(edges, { blocker: B, blocked: C })).toBe(false);
  });
});

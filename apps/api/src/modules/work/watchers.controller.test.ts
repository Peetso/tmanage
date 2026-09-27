import { beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { WorkWatchersController } from './watchers.controller.js';
import { WorkWatchersService } from './watchers.service.js';
import type { WorkItemsRepository } from './work-items.repository.js';
import { ApiError } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { WorkItemRow, WorkItemWatcherRow } from '../../common/database/schema.js';

/**
 * x232 — the fast, database-free proof of the watchers sub-resource. It runs the controller over an
 * in-memory watcher store and a fake work-item lookup, with the **real** `authorize`: the
 * resolve-then-authorize order, the cross-tenant 404 (no write), idempotent subscribe and the
 * self-only, email-free projection are the behaviours a wiring bug would break, and none needs
 * MySQL. The composite foreign key and the unique key are proved against the real engine by the
 * chain's DB suite, not here.
 */

const ORG = '01890000-0000-7000-8000-00000000000a';
const PROJECT = '01890000-0000-7000-8000-000000000101';
const WORK_ID = '01890000-0000-7000-8000-000000000201';
const MEMBERSHIP = '01890000-0000-7000-8000-000000000011';

const context = { organizationId: ORG } as unknown as TenantContext;

function member(
  projectIds: readonly string[],
  membershipId: string | null = MEMBERSHIP,
): Principal {
  return {
    userId: '01890000-0000-7000-8000-000000000001',
    organizationId: ORG,
    kind: 'internal',
    role: 'member',
    membershipId,
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds,
    hasOrgWideScope: false,
  } as Principal;
}

function workItem(over: Partial<WorkItemRow> = {}): WorkItemRow {
  const now = new Date();
  return {
    id: WORK_ID,
    organizationId: ORG,
    projectId: PROJECT,
    type: 'task',
    title: 'Assemble the brand book',
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

/** An in-memory watcher store standing in for the repository, counting its writes. */
class FakeWatchersRepository {
  readonly rows: WorkItemWatcherRow[] = [];
  creates = 0;
  deletes = 0;

  async findForMember(_r: unknown, _c: TenantContext, workItemId: string, memberId: string) {
    return (
      this.rows.find((row) => row.workItemId === workItemId && row.memberId === memberId) ?? null
    );
  }

  async listForWorkItem(_r: unknown, _c: TenantContext, workItemId: string) {
    return this.rows
      .filter((row) => row.workItemId === workItemId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  async create(_r: unknown, _c: TenantContext, input: { workItemId: string; memberId: string }) {
    this.creates += 1;
    const row: WorkItemWatcherRow = {
      id: `watch-${this.rows.length + 1}`,
      organizationId: ORG,
      workItemId: input.workItemId,
      memberId: input.memberId,
      createdAt: new Date(Date.now() + this.rows.length),
    };
    this.rows.push(row);
    return row;
  }

  async deleteForMember(_r: unknown, _c: TenantContext, workItemId: string, memberId: string) {
    this.deletes += 1;
    const at = this.rows.findIndex(
      (row) => row.workItemId === workItemId && row.memberId === memberId,
    );
    if (at >= 0) this.rows.splice(at, 1);
  }
}

function harness(parent: WorkItemRow | null) {
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const workItems = { findById: async () => parent } as unknown as WorkItemsRepository;
  const watchers = new FakeWatchersRepository();
  const service = new WorkWatchersService(
    database,
    workItems,
    watchers as unknown as ConstructorParameters<typeof WorkWatchersService>[2],
  );
  return { controller: new WorkWatchersController(service), watchers };
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

describe('WorkWatchersController', () => {
  let harnessed: ReturnType<typeof harness>;

  beforeEach(() => {
    harnessed = harness(workItem());
  });

  it('subscribes the caller and lists watchers with no email in the projection', async () => {
    const { controller } = harnessed;
    const related = member([PROJECT]);

    const watch = await controller.subscribe(context, related, WORK_ID);
    expect(watch).toMatchObject({ workItemId: WORK_ID, memberId: MEMBERSHIP });
    // The projection is exactly the roster shape — no email, no user id.
    expect(Object.keys(watch).sort()).toEqual(['createdAt', 'id', 'memberId', 'workItemId']);

    const listed = await controller.list(context, related, WORK_ID);
    expect(listed.watchers).toHaveLength(1);
    expect(listed.watchers[0]).toMatchObject({ id: watch.id, memberId: MEMBERSHIP });
  });

  it('is idempotent: a repeated subscribe returns the same row and writes once', async () => {
    const { controller, watchers } = harnessed;
    const related = member([PROJECT]);

    const first = await controller.subscribe(context, related, WORK_ID);
    const again = await controller.subscribe(context, related, WORK_ID);

    expect(again.id).toBe(first.id);
    expect(watchers.creates).toBe(1);
    const listed = await controller.list(context, related, WORK_ID);
    expect(listed.watchers).toHaveLength(1);
  });

  it('unsubscribes the caller and stays idempotent when nothing is watched', async () => {
    const { controller, watchers } = harnessed;
    const related = member([PROJECT]);

    await controller.subscribe(context, related, WORK_ID);
    await controller.unsubscribe(context, related, WORK_ID);
    expect((await controller.list(context, related, WORK_ID)).watchers).toHaveLength(0);

    // A second unsubscribe still succeeds — a no-op delete, no throw.
    await expect(controller.unsubscribe(context, related, WORK_ID)).resolves.toBeUndefined();
    expect(watchers.deletes).toBe(2);
  });

  it('answers 404 and writes nothing when the parent work item is cross-tenant or absent', async () => {
    const { controller, watchers } = harness(null);
    const status = await statusOf(() => controller.subscribe(context, member([PROJECT]), WORK_ID));
    expect(status).toBe(404);
    expect(watchers.creates).toBe(0);
  });

  it('gates read access: an unrelated member gets 404 on the watcher list', async () => {
    const { controller } = harnessed;
    const status = await statusOf(() => controller.list(context, member([]), WORK_ID));
    expect(status).toBe(404);
  });
});

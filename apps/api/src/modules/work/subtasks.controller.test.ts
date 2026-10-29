import { beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { WorkSubtasksController } from './subtasks.controller.js';
import { WorkSubtasksService } from './subtasks.service.js';
import type { WorkItemsRepository } from './work-items.repository.js';
import { ApiError } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { WorkItemRow, WorkItemSubtaskRow } from '../../common/database/schema.js';

/**
 * x307 — the fast, database-free proof of the subtask sub-resource. It runs the controller over an
 * in-memory subtask store and a fake work-item lookup, with the **real** `authorize`: the
 * resolve-then-authorize order, the cross-tenant 404 (no write) and the read/write capability gates
 * are the behaviours a wiring bug would break, and none of them needs MySQL. The composite foreign
 * key, the immutability trigger and the delete are proved against the real engine by the chain's DB
 * suite, not here.
 */

const ORG = '01890000-0000-7000-8000-00000000000a';
const PROJECT = '01890000-0000-7000-8000-000000000101';
const WORK_ID = '01890000-0000-7000-8000-000000000201';
const USER = '01890000-0000-7000-8000-000000000001';

const context = { organizationId: ORG, userId: USER } as unknown as TenantContext;

/** An internal member related to exactly the projects listed. */
function member(projectIds: readonly string[]): Principal {
  return {
    userId: USER,
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

function workItem(over: Partial<WorkItemRow> = {}): WorkItemRow {
  const now = new Date();
  return {
    id: WORK_ID,
    organizationId: ORG,
    projectId: PROJECT,
    type: 'task',
    title: 'Ship the launch page',
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

/** An in-memory subtask store standing in for the repository, counting its writes. */
class FakeSubtasksRepository {
  readonly rows: WorkItemSubtaskRow[] = [];
  creates = 0;
  deletes = 0;

  async findSubtask(_r: unknown, _c: TenantContext, parentWorkItemId: string, subtaskId: string) {
    return (
      this.rows.find((r) => r.parentWorkItemId === parentWorkItemId && r.id === subtaskId) ?? null
    );
  }

  async listForWorkItem(_r: unknown, _c: TenantContext, parentWorkItemId: string) {
    return this.rows
      .filter((r) => r.parentWorkItemId === parentWorkItemId)
      .sort((a, b) => a.position - b.position);
  }

  async create(
    _r: unknown,
    _c: TenantContext,
    input: { parentWorkItemId: string; title: string; createdBy: string },
  ) {
    this.creates += 1;
    const row: WorkItemSubtaskRow = {
      id: `sub-${this.rows.length + 1}`,
      organizationId: ORG,
      parentWorkItemId: input.parentWorkItemId,
      title: input.title,
      isDone: false,
      position: this.rows.length,
      createdBy: input.createdBy,
      createdAt: new Date(),
    };
    this.rows.push(row);
    return row;
  }

  async update(
    _r: unknown,
    _c: TenantContext,
    parentWorkItemId: string,
    subtaskId: string,
    input: { title?: string; isDone?: boolean; position?: number },
  ) {
    const row = this.rows.find(
      (r) => r.parentWorkItemId === parentWorkItemId && r.id === subtaskId,
    );
    if (!row) return null;
    if (input.title !== undefined) row.title = input.title;
    if (input.isDone !== undefined) row.isDone = input.isDone;
    if (input.position !== undefined) row.position = input.position;
    return row;
  }

  async deleteSubtask(_r: unknown, _c: TenantContext, parentWorkItemId: string, subtaskId: string) {
    this.deletes += 1;
    const index = this.rows.findIndex(
      (r) => r.parentWorkItemId === parentWorkItemId && r.id === subtaskId,
    );
    if (index >= 0) this.rows.splice(index, 1);
  }
}

function harness(parent: WorkItemRow | null) {
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const workItems = { findById: async () => parent } as unknown as WorkItemsRepository;
  const subtasks = new FakeSubtasksRepository();
  const service = new WorkSubtasksService(
    database,
    workItems,
    subtasks as unknown as ConstructorParameters<typeof WorkSubtasksService>[2],
  );
  return { controller: new WorkSubtasksController(service), subtasks };
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

describe('WorkSubtasksController', () => {
  let harnessed: ReturnType<typeof harness>;

  beforeEach(() => {
    harnessed = harness(workItem());
  });

  it('adds, lists with a done/total roll-up, toggles and deletes for a related member', async () => {
    const { controller, subtasks } = harnessed;
    const related = member([PROJECT]);

    const a = await controller.add(context, related, WORK_ID, { title: 'Draft copy' });
    const b = await controller.add(context, related, WORK_ID, { title: 'Pick hero image' });
    expect(a).toMatchObject({ title: 'Draft copy', done: false, position: 0 });

    let listed = await controller.list(context, related, WORK_ID);
    expect(listed).toMatchObject({ done: 0, total: 2 });
    expect(listed.items).toHaveLength(2);

    await controller.update(context, related, WORK_ID, a.id, { done: true });
    listed = await controller.list(context, related, WORK_ID);
    expect(listed).toMatchObject({ done: 1, total: 2 });

    await controller.remove(context, related, WORK_ID, b.id);
    expect(subtasks.deletes).toBe(1);
    listed = await controller.list(context, related, WORK_ID);
    expect(listed).toMatchObject({ done: 1, total: 1 });
  });

  it('rejects an empty title with 400 and writes nothing', async () => {
    const { controller, subtasks } = harnessed;
    const status = await statusOf(() =>
      controller.add(context, member([PROJECT]), WORK_ID, { title: '   ' }),
    );
    expect(status).toBe(400);
    expect(subtasks.creates).toBe(0);
  });

  it('answers 404 and writes nothing when the parent work item is cross-tenant or absent', async () => {
    const { controller, subtasks } = harness(null);
    const status = await statusOf(() =>
      controller.add(context, member([PROJECT]), WORK_ID, { title: 'Should never land' }),
    );
    expect(status).toBe(404);
    expect(subtasks.creates).toBe(0);
  });

  it('gates the list behind read access: an unrelated member gets 404', async () => {
    const { controller } = harnessed;
    const status = await statusOf(() => controller.list(context, member([]), WORK_ID));
    expect(status).toBe(404);
  });

  it('refuses the write with 403 when the caller may read the item but not update it', async () => {
    // An archived item permits an internal read for history but denies every write — real
    // `authorize`, `resource_not_active`. The reader is related, so its existence is not a secret:
    // the refusal is 403, not the 404 an unrelated caller would get, and nothing is inserted.
    const { controller, subtasks } = harness(workItem({ state: 'archived' }));
    const status = await statusOf(() =>
      controller.add(context, member([PROJECT]), WORK_ID, { title: 'No writes on archived' }),
    );
    expect(status).toBe(403);
    expect(subtasks.creates).toBe(0);
  });
});

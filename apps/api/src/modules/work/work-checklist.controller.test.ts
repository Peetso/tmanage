import { beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { WorkChecklistController } from './work-checklist.controller.js';
import { WorkChecklistService } from './work-checklist.service.js';
import type { WorkItemsRepository } from './work-items.repository.js';
import { ApiError } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { WorkItemChecklistItemRow, WorkItemRow } from '../../common/database/schema.js';

/**
 * x145 — the fast, database-free proof of the checklist sub-resource. It runs the controller
 * over an in-memory checklist store and a fake work-item lookup, with the **real** `authorize`:
 * the resolve-then-authorize order, the cross-tenant 404 (no write) and the read/write capability
 * gates are the behaviours a wiring bug would break, and none of them needs MySQL. The composite
 * foreign key and the immutability trigger are proved against the real engine by the chain's DB
 * suite, not here.
 */

const ORG = '01890000-0000-7000-8000-00000000000a';
const PROJECT = '01890000-0000-7000-8000-000000000101';
const WORK_ID = '01890000-0000-7000-8000-000000000201';

const context = { organizationId: ORG } as unknown as TenantContext;

/** An internal member related to exactly the projects listed. */
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
    deletedByUserId: null,
    deletedReason: null,
    purgeAfter: null,
    ...over,
  };
}

/** An in-memory checklist store standing in for the repository, counting its writes. */
class FakeChecklistRepository {
  readonly rows: WorkItemChecklistItemRow[] = [];
  creates = 0;

  async findItem(_r: unknown, _c: TenantContext, workItemId: string, itemId: string) {
    return this.rows.find((row) => row.workItemId === workItemId && row.id === itemId) ?? null;
  }

  async listForWorkItem(_r: unknown, _c: TenantContext, workItemId: string) {
    return this.rows
      .filter((row) => row.workItemId === workItemId)
      .sort((a, b) => a.position - b.position);
  }

  async create(_r: unknown, _c: TenantContext, input: { workItemId: string; label: string }) {
    this.creates += 1;
    const row: WorkItemChecklistItemRow = {
      id: `item-${this.rows.length + 1}`,
      organizationId: ORG,
      workItemId: input.workItemId,
      label: input.label,
      done: false,
      position: this.rows.length,
      createdAt: new Date(),
    };
    this.rows.push(row);
    return row;
  }

  async update(
    _r: unknown,
    _c: TenantContext,
    workItemId: string,
    itemId: string,
    input: { label?: string; done?: boolean },
  ) {
    const row = this.rows.find((r) => r.workItemId === workItemId && r.id === itemId);
    if (!row) return null;
    if (input.label !== undefined) row.label = input.label;
    if (input.done !== undefined) row.done = input.done;
    return row;
  }
}

function harness(parent: WorkItemRow | null) {
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const workItems = { findById: async () => parent } as unknown as WorkItemsRepository;
  const checklist = new FakeChecklistRepository();
  const service = new WorkChecklistService(
    database,
    workItems,
    checklist as unknown as ConstructorParameters<typeof WorkChecklistService>[2],
  );
  return { controller: new WorkChecklistController(service), checklist };
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

describe('WorkChecklistController', () => {
  let harnessed: ReturnType<typeof harness>;

  beforeEach(() => {
    harnessed = harness(workItem());
  });

  it('adds, lists and toggles a checklist item for a related member', async () => {
    const { controller } = harnessed;
    const related = member([PROJECT]);

    const added = await controller.add(context, related, WORK_ID, { label: 'Choose the cover' });
    expect(added).toMatchObject({ label: 'Choose the cover', done: false, position: 0 });

    const listed = await controller.list(context, related, WORK_ID);
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]).toMatchObject({ id: added.id, done: false });

    const toggled = await controller.update(context, related, WORK_ID, added.id, { done: true });
    expect(toggled).toMatchObject({ id: added.id, done: true });
  });

  it('answers 404 and writes nothing when the parent work item is cross-tenant or absent', async () => {
    const { controller, checklist } = harness(null);
    const status = await statusOf(() =>
      controller.add(context, member([PROJECT]), WORK_ID, { label: 'Should never land' }),
    );
    expect(status).toBe(404);
    expect(checklist.creates).toBe(0);
  });

  it('gates the list behind read access: an unrelated member gets 404', async () => {
    const { controller } = harnessed;
    const status = await statusOf(() => controller.list(context, member([]), WORK_ID));
    expect(status).toBe(404);
  });

  it('refuses the write with 403 when the caller may read the item but not update it', async () => {
    // An archived item permits an internal read for history but denies every write — real
    // `authorize`, `resource_not_active`. The reader is related, so its existence is not a secret:
    // the refusal is 403, not the 404 an unrelated caller would get.
    const { controller, checklist } = harness(workItem({ state: 'archived' }));
    const status = await statusOf(() =>
      controller.add(context, member([PROJECT]), WORK_ID, { label: 'No writes on archived' }),
    );
    expect(status).toBe(403);
    expect(checklist.creates).toBe(0);
  });
});

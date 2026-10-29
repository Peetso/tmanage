import { beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { WorkLabelsController } from './work-labels.controller.js';
import { WorkLabelsService } from './work-labels.service.js';
import type { WorkLabelsRepository } from './work-labels.repository.js';
import type { WorkItemsRepository } from './work-items.repository.js';
import { ApiError } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { WorkItemLabelRow, WorkItemRow } from '../../common/database/schema.js';

/**
 * x233 — the fast, database-free proof of work item labels. It runs the controller over an in-memory
 * label store and a fake work-item lookup, with the **real** `authorize`: the resolve-then-authorize
 * order, the cross-tenant 404 (no write), the write capability gate, the unique-name 409, the palette
 * 400 and idempotent tagging are what a wiring bug would break, and none needs MySQL. The composite
 * foreign keys and the immutability trigger are proved against the engine by the chain's DB suite.
 */

const ORG = '01890000-0000-7000-8000-00000000000a';
const PROJECT = '01890000-0000-7000-8000-000000000101';
const WORK_ID = '01890000-0000-7000-8000-000000000201';
const MEMBERSHIP = '01890000-0000-7000-8000-000000000011';

const context = { organizationId: ORG } as unknown as TenantContext;

function member(projectIds: readonly string[]): Principal {
  return {
    userId: '01890000-0000-7000-8000-000000000001',
    organizationId: ORG,
    kind: 'internal',
    role: 'member',
    membershipId: MEMBERSHIP,
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

/** In-memory label store standing in for the repository, counting its writes. */
class FakeLabelsRepository {
  readonly defs: WorkItemLabelRow[] = [];
  readonly assigns: WorkItemLabelRow[] = [];
  writes = 0;

  async listDefinitions() {
    return [...this.defs].sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
  }
  async findDefinition(_r: unknown, _c: TenantContext, labelId: string) {
    return this.defs.find((row) => row.id === labelId) ?? null;
  }
  async findDefinitionByName(_r: unknown, _c: TenantContext, name: string) {
    return this.defs.find((row) => row.name === name) ?? null;
  }
  async createDefinition(_r: unknown, _c: TenantContext, input: { name: string; color: string }) {
    this.writes += 1;
    const row = row_(`def-${this.defs.length + 1}`, {
      name: input.name,
      color: input.color,
    });
    this.defs.push(row);
    return row;
  }
  async listAssignments(_r: unknown, _c: TenantContext, workItemId: string) {
    return this.assigns.filter((row) => row.workItemId === workItemId);
  }
  async findAssignment(_r: unknown, _c: TenantContext, workItemId: string, labelId: string) {
    return (
      this.assigns.find((row) => row.workItemId === workItemId && row.labelId === labelId) ?? null
    );
  }
  async createAssignment(_r: unknown, _c: TenantContext, workItemId: string, labelId: string) {
    this.writes += 1;
    const row = row_(`asg-${this.assigns.length + 1}`, { workItemId, labelId });
    this.assigns.push(row);
    return row;
  }
  async deleteAssignment(_r: unknown, _c: TenantContext, workItemId: string, labelId: string) {
    const before = this.assigns.length;
    for (let i = this.assigns.length - 1; i >= 0; i -= 1) {
      const row = this.assigns[i] as WorkItemLabelRow;
      if (row.workItemId === workItemId && row.labelId === labelId) this.assigns.splice(i, 1);
    }
    return this.assigns.length < before;
  }
}

function row_(id: string, over: Partial<WorkItemLabelRow>): WorkItemLabelRow {
  return {
    id,
    organizationId: ORG,
    workItemId: null,
    labelId: null,
    name: null,
    color: null,
    createdAt: new Date(),
    ...over,
  };
}

function harness(parent: WorkItemRow | null) {
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const workItems = { findById: async () => parent } as unknown as WorkItemsRepository;
  const labels = new FakeLabelsRepository();
  const service = new WorkLabelsService(
    database,
    workItems,
    labels as unknown as WorkLabelsRepository,
  );
  return { controller: new WorkLabelsController(service), labels };
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

describe('WorkLabelsController', () => {
  let h: ReturnType<typeof harness>;

  beforeEach(() => {
    h = harness(workItem());
  });

  it('defines a label and lists it', async () => {
    const defined = await h.controller.define(context, { name: 'Urgent', color: 'red' });
    expect(defined).toMatchObject({ name: 'Urgent', color: 'red' });
    const listed = await h.controller.list(context);
    expect(listed.labels).toHaveLength(1);
    expect(listed.labels[0]).toMatchObject({ name: 'Urgent', color: 'red' });
  });

  it('rejects a duplicate label name with 409 and a bad colour with 400', async () => {
    await h.controller.define(context, { name: 'Urgent', color: 'red' });
    expect(
      await statusOf(() => h.controller.define(context, { name: 'Urgent', color: 'blue' })),
    ).toBe(409);
    expect(
      await statusOf(() => h.controller.define(context, { name: 'Later', color: 'chartreuse' })),
    ).toBe(400);
  });

  it('assigns a label to an item and removes it, idempotently', async () => {
    const label = await h.controller.define(context, { name: 'Urgent', color: 'red' });
    const related = member([PROJECT]);
    const first = await h.controller.assign(context, related, WORK_ID, { labelId: label.id });
    expect(first).toMatchObject({ workItemId: WORK_ID, labelId: label.id, name: 'Urgent' });
    // Idempotent: a second identical assign does not create a duplicate.
    await h.controller.assign(context, related, WORK_ID, { labelId: label.id });
    expect((await h.controller.listForItem(context, related, WORK_ID)).labels).toHaveLength(1);
    await h.controller.remove(context, related, WORK_ID, label.id);
    expect((await h.controller.listForItem(context, related, WORK_ID)).labels).toHaveLength(0);
  });

  it('answers 404 and writes nothing when the parent work item is cross-tenant or absent', async () => {
    const { controller, labels } = harness(null);
    const label = row_('def-x', { name: 'X', color: 'red' });
    labels.defs.push(label);
    const status = await statusOf(() =>
      controller.assign(context, member([PROJECT]), WORK_ID, { labelId: label.id }),
    );
    expect(status).toBe(404);
    expect(labels.assigns).toHaveLength(0);
  });

  it('answers 404 for an unknown or cross-tenant label id', async () => {
    const status = await statusOf(() =>
      h.controller.assign(context, member([PROJECT]), WORK_ID, { labelId: 'no-such-label' }),
    );
    expect(status).toBe(404);
    expect(h.labels.assigns).toHaveLength(0);
  });

  it('refuses the assign with 403 when the caller may read the item but not update it', async () => {
    const { controller, labels } = harness(workItem({ state: 'archived' }));
    const label = row_('def-a', { name: 'A', color: 'red' });
    labels.defs.push(label);
    const status = await statusOf(() =>
      controller.assign(context, member([PROJECT]), WORK_ID, { labelId: label.id }),
    );
    expect(status).toBe(403);
    expect(labels.assigns).toHaveLength(0);
  });
});

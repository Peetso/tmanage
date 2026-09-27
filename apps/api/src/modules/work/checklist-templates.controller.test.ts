import { beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { WorkChecklistTemplatesController } from './checklist-templates.controller.js';
import { WorkChecklistTemplatesService } from './checklist-templates.service.js';
import type { WorkChecklistTemplatesRepository } from './checklist-templates.repository.js';
import type { WorkItemsRepository } from './work-items.repository.js';
import { ApiError } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { WorkChecklistTemplateRow, WorkItemRow } from '../../common/database/schema.js';

/**
 * x292 — the fast, database-free proof of checklist templates. It runs the controller over an
 * in-memory template store and a fake work-item lookup, with the **real** `authorize`: the org-level
 * capability gate on define (a caller without `work.update` is a 403), the resolve-then-authorize
 * order on apply, the cross-tenant 404 (no seed), the duplicate-name 409, the validation 400s and the
 * idempotent seed are what a wiring bug would break, and none needs MySQL. The composite foreign keys
 * and the immutability trigger are proved against the engine by the chain's DB suite.
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

/** A client principal holds no internal `work.update`; used to prove the define refusal. */
function client(): Principal {
  return {
    userId: '01890000-0000-7000-8000-000000000002',
    organizationId: ORG,
    kind: 'client',
    role: 'client_viewer',
    membershipId: '01890000-0000-7000-8000-000000000012',
    membershipStatus: 'active',
    clientOrganizationId: '01890000-0000-7000-8000-0000000000c1',
    projectIds: [PROJECT],
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
    ...over,
  };
}

/** In-memory template store standing in for the repository, counting checklist rows seeded. */
class FakeTemplatesRepository {
  readonly rows: WorkChecklistTemplateRow[] = [];
  /** work item id -> checklist labels already present, so seeding stays idempotent. */
  readonly checklist = new Map<string, string[]>();
  seededCalls = 0;

  async list() {
    return [...this.rows].sort((a, b) => a.name.localeCompare(b.name));
  }
  async findById(_r: unknown, _c: TenantContext, id: string) {
    return this.rows.find((row) => row.id === id) ?? null;
  }
  async findByName(_r: unknown, _c: TenantContext, name: string) {
    return this.rows.find((row) => row.name === name) ?? null;
  }
  async create(
    _r: unknown,
    _c: TenantContext,
    input: { name: string; labels: readonly string[]; createdBy: string | null },
  ) {
    const row: WorkChecklistTemplateRow = {
      id: `tpl-${this.rows.length + 1}`,
      organizationId: ORG,
      name: input.name,
      labelsJson: [...input.labels],
      createdBy: input.createdBy,
      createdAt: new Date(),
    };
    this.rows.push(row);
    return row;
  }
  async delete(_r: unknown, _c: TenantContext, id: string) {
    const before = this.rows.length;
    const index = this.rows.findIndex((row) => row.id === id);
    if (index >= 0) this.rows.splice(index, 1);
    return this.rows.length < before;
  }
  async seedChecklistItems(
    _r: unknown,
    _c: TenantContext,
    workItemId: string,
    labels: readonly string[],
  ) {
    this.seededCalls += 1;
    const present = this.checklist.get(workItemId) ?? [];
    let seeded = 0;
    for (const label of labels) {
      if (present.includes(label)) continue;
      present.push(label);
      seeded += 1;
    }
    this.checklist.set(workItemId, present);
    return seeded;
  }
}

function harness(parent: WorkItemRow | null) {
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const workItems = { findById: async () => parent } as unknown as WorkItemsRepository;
  const templates = new FakeTemplatesRepository();
  const service = new WorkChecklistTemplatesService(
    database,
    workItems,
    templates as unknown as WorkChecklistTemplatesRepository,
  );
  return { controller: new WorkChecklistTemplatesController(service), templates };
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

describe('WorkChecklistTemplatesController', () => {
  let h: ReturnType<typeof harness>;

  beforeEach(() => {
    h = harness(workItem());
  });

  it('defines a template and lists it', async () => {
    const defined = await h.controller.define(context, member([PROJECT]), {
      name: 'Onboarding',
      labels: ['Contract', 'Kickoff'],
    });
    expect(defined).toMatchObject({ name: 'Onboarding', labels: ['Contract', 'Kickoff'] });
    const listed = await h.controller.list(context, member([PROJECT]));
    expect(listed.templates).toHaveLength(1);
    expect(listed.templates[0]).toMatchObject({ name: 'Onboarding' });
  });

  it('rejects a duplicate name with 409 and empty name/labels with 400', async () => {
    await h.controller.define(context, member([PROJECT]), { name: 'Dup', labels: ['A'] });
    expect(
      await statusOf(() =>
        h.controller.define(context, member([PROJECT]), { name: 'Dup', labels: ['B'] }),
      ),
    ).toBe(409);
    expect(
      await statusOf(() =>
        h.controller.define(context, member([PROJECT]), { name: '  ', labels: ['A'] }),
      ),
    ).toBe(400);
    expect(
      await statusOf(() =>
        h.controller.define(context, member([PROJECT]), { name: 'Empty', labels: [] }),
      ),
    ).toBe(400);
  });

  it('applies a template to an item and is idempotent', async () => {
    const tpl = await h.controller.define(context, member([PROJECT]), {
      name: 'Onboarding',
      labels: ['Contract', 'Kickoff'],
    });
    const first = await h.controller.apply(context, member([PROJECT]), WORK_ID, tpl.id);
    expect(first).toMatchObject({ workItemId: WORK_ID, templateId: tpl.id, seeded: 2 });
    // Re-applying seeds nothing: the labels are already present.
    const again = await h.controller.apply(context, member([PROJECT]), WORK_ID, tpl.id);
    expect(again.seeded).toBe(0);
  });

  it('refuses define with 403 when the caller does not hold work.update', async () => {
    const status = await statusOf(() =>
      h.controller.define(context, client(), { name: 'Nope', labels: ['A'] }),
    );
    expect(status).toBe(403);
    expect(h.templates.rows).toHaveLength(0);
  });

  it('answers 404 and seeds nothing when applying to a cross-tenant or absent work item', async () => {
    const { controller, templates } = harness(null);
    const tpl = await controller.define(context, member([PROJECT]), {
      name: 'T',
      labels: ['A'],
    });
    const status = await statusOf(() =>
      controller.apply(context, member([PROJECT]), WORK_ID, tpl.id),
    );
    expect(status).toBe(404);
    expect(templates.seededCalls).toBe(0);
  });

  it('answers 404 for an unknown or cross-tenant template id', async () => {
    const status = await statusOf(() =>
      h.controller.apply(context, member([PROJECT]), WORK_ID, 'no-such-template'),
    );
    expect(status).toBe(404);
    expect(h.templates.seededCalls).toBe(0);
  });

  it('refuses apply with 403 when the caller may read the item but not update it', async () => {
    const { controller, templates } = harness(workItem({ state: 'archived' }));
    const tpl = await controller.define(context, member([PROJECT]), { name: 'T', labels: ['A'] });
    const status = await statusOf(() =>
      controller.apply(context, member([PROJECT]), WORK_ID, tpl.id),
    );
    expect(status).toBe(403);
    expect(templates.seededCalls).toBe(0);
  });
});

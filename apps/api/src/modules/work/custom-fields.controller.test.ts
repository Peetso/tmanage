import { beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { WorkCustomFieldsController } from './custom-fields.controller.js';
import { WorkCustomFieldsService } from './custom-fields.service.js';
import type { WorkCustomFieldsRepository } from './custom-fields.repository.js';
import type { WorkItemsRepository } from './work-items.repository.js';
import { ApiError } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { WorkItemCustomFieldRow, WorkItemRow } from '../../common/database/schema.js';

/**
 * x306 — the fast, database-free proof of work item custom fields. It runs the controller over an
 * in-memory store and a fake work-item lookup, with the **real** `authorize`: the `org.manage` gate on
 * definitions (403, no insert), the resolve-then-authorize order on values, the cross-tenant 404 (no
 * write), the unknown-key 404, and the select/number type 400 are what a wiring bug would break, and
 * none needs MySQL. The composite foreign key and the immutability trigger are proved against the
 * engine by the chain's DB suite.
 */

const ORG = '01890000-0000-7000-8000-00000000000a';
const PROJECT = '01890000-0000-7000-8000-000000000101';
const WORK_ID = '01890000-0000-7000-8000-000000000201';
const MEMBERSHIP = '01890000-0000-7000-8000-000000000011';

const context = { organizationId: ORG } as unknown as TenantContext;

/** An owner — the one internal role whose ceiling still holds `org.manage`. */
function owner(): Principal {
  return {
    userId: '01890000-0000-7000-8000-000000000001',
    organizationId: ORG,
    kind: 'internal',
    role: 'owner',
    membershipId: MEMBERSHIP,
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [PROJECT],
    hasOrgWideScope: true,
  };
}

/** A plain member — holds work.read/work.update on their projects, never org.manage. */
function member(projectIds: readonly string[]): Principal {
  return {
    userId: '01890000-0000-7000-8000-000000000002',
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

/** In-memory custom-field store standing in for the repository, counting its writes. */
class FakeFieldsRepository {
  readonly defs: WorkItemCustomFieldRow[] = [];
  readonly values: WorkItemCustomFieldRow[] = [];
  writes = 0;

  async listDefinitions() {
    return [...this.defs].sort((a, b) =>
      (a.definitionKey ?? '').localeCompare(b.definitionKey ?? ''),
    );
  }
  async findDefinitionByKey(_r: unknown, _c: TenantContext, key: string) {
    return this.defs.find((row) => row.definitionKey === key) ?? null;
  }
  async createDefinition(
    _r: unknown,
    _c: TenantContext,
    input: {
      definitionKey: string;
      name: string;
      fieldType: 'text' | 'number' | 'select';
      options: readonly string[] | null;
    },
  ) {
    this.writes += 1;
    const row = defRow(`def-${this.defs.length + 1}`, input);
    this.defs.push(row);
    return row;
  }
  async deleteDefinition(_r: unknown, _c: TenantContext, key: string) {
    const before = this.defs.length;
    for (let i = this.defs.length - 1; i >= 0; i -= 1) {
      if ((this.defs[i] as WorkItemCustomFieldRow).definitionKey === key) this.defs.splice(i, 1);
    }
    return this.defs.length < before;
  }
  async listValues(_r: unknown, _c: TenantContext, workItemId: string) {
    return this.values.filter((row) => row.workItemId === workItemId);
  }
  async findValue(_r: unknown, _c: TenantContext, workItemId: string, valueKey: string) {
    return (
      this.values.find((row) => row.workItemId === workItemId && row.valueKey === valueKey) ?? null
    );
  }
  async upsertValue(
    _r: unknown,
    _c: TenantContext,
    input: { workItemId: string; valueKey: string; valueText: string },
  ) {
    this.writes += 1;
    const existing = this.values.find(
      (row) => row.workItemId === input.workItemId && row.valueKey === input.valueKey,
    );
    if (existing) {
      existing.valueText = input.valueText;
      return existing;
    }
    const row = valueRow(`val-${this.values.length + 1}`, input);
    this.values.push(row);
    return row;
  }
}

function defRow(
  id: string,
  input: {
    definitionKey: string;
    name: string;
    fieldType: 'text' | 'number' | 'select';
    options: readonly string[] | null;
  },
): WorkItemCustomFieldRow {
  return {
    id,
    organizationId: ORG,
    rowKind: 'definition',
    definitionKey: input.definitionKey,
    name: input.name,
    fieldType: input.fieldType,
    options: input.options,
    workItemId: null,
    valueKey: null,
    valueText: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function valueRow(
  id: string,
  input: { workItemId: string; valueKey: string; valueText: string },
): WorkItemCustomFieldRow {
  return {
    id,
    organizationId: ORG,
    rowKind: 'value',
    definitionKey: null,
    name: null,
    fieldType: null,
    options: null,
    workItemId: input.workItemId,
    valueKey: input.valueKey,
    valueText: input.valueText,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function harness(parent: WorkItemRow | null) {
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const workItems = { findById: async () => parent } as unknown as WorkItemsRepository;
  const fields = new FakeFieldsRepository();
  const service = new WorkCustomFieldsService(
    database,
    workItems,
    fields as unknown as WorkCustomFieldsRepository,
  );
  return { controller: new WorkCustomFieldsController(service), fields };
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

describe('WorkCustomFieldsController', () => {
  let h: ReturnType<typeof harness>;

  beforeEach(() => {
    h = harness(workItem());
  });

  it('defines a field and lists it for an owner', async () => {
    const defined = await h.controller.define(context, owner(), {
      key: 'priority',
      name: 'Priority',
      fieldType: 'select',
      options: ['low', 'high'],
    });
    expect(defined).toMatchObject({ key: 'priority', name: 'Priority', fieldType: 'select' });
    const listed = await h.controller.listDefinitions(context, owner());
    expect(listed.fields).toHaveLength(1);
  });

  it('refuses a define without org.manage with 403 and writes nothing', async () => {
    const status = await statusOf(() =>
      h.controller.define(context, member([PROJECT]), {
        key: 'priority',
        name: 'Priority',
        fieldType: 'text',
        options: null,
      }),
    );
    expect(status).toBe(403);
    expect(h.fields.defs).toHaveLength(0);
    expect(h.fields.writes).toBe(0);
  });

  it('rejects an empty key/name with 400 and a select with no options with 400', async () => {
    expect(
      await statusOf(() =>
        h.controller.define(context, owner(), {
          key: '  ',
          name: 'X',
          fieldType: 'text',
          options: null,
        }),
      ),
    ).toBe(400);
    expect(
      await statusOf(() =>
        h.controller.define(context, owner(), {
          key: 'sel',
          name: 'Sel',
          fieldType: 'select',
          options: [],
        }),
      ),
    ).toBe(400);
    expect(h.fields.defs).toHaveLength(0);
  });

  it('sets a value and reads the field+value map, idempotently', async () => {
    await h.controller.define(context, owner(), {
      key: 'priority',
      name: 'Priority',
      fieldType: 'select',
      options: ['low', 'high'],
    });
    const related = member([PROJECT]);
    const set = await h.controller.setValue(context, related, WORK_ID, 'priority', {
      value: 'high',
    });
    expect(set).toMatchObject({ key: 'priority', value: 'high' });
    // Idempotent: a re-set revises in place, not a duplicate.
    await h.controller.setValue(context, related, WORK_ID, 'priority', { value: 'low' });
    const map = await h.controller.listForItem(context, related, WORK_ID);
    expect(map.fields).toHaveLength(1);
    expect(map.fields[0]).toMatchObject({ key: 'priority', value: 'low' });
    expect(h.fields.values).toHaveLength(1);
  });

  it('answers 404 and writes nothing when the parent work item is cross-tenant or absent', async () => {
    const { controller, fields } = harness(null);
    fields.defs.push(
      defRow('def-x', { definitionKey: 'k', name: 'K', fieldType: 'text', options: null }),
    );
    const status = await statusOf(() =>
      controller.setValue(context, member([PROJECT]), WORK_ID, 'k', { value: 'v' }),
    );
    expect(status).toBe(404);
    expect(fields.values).toHaveLength(0);
  });

  it('answers 404 for an unknown field key on a set', async () => {
    const status = await statusOf(() =>
      h.controller.setValue(context, member([PROJECT]), WORK_ID, 'no-such-field', { value: 'v' }),
    );
    expect(status).toBe(404);
    expect(h.fields.values).toHaveLength(0);
  });

  it('rejects a select value outside the options with 400 and no upsert', async () => {
    await h.controller.define(context, owner(), {
      key: 'priority',
      name: 'Priority',
      fieldType: 'select',
      options: ['low', 'high'],
    });
    const status = await statusOf(() =>
      h.controller.setValue(context, member([PROJECT]), WORK_ID, 'priority', { value: 'urgent' }),
    );
    expect(status).toBe(400);
    expect(h.fields.values).toHaveLength(0);
  });

  it('rejects a non-numeric value on a number field with 400 and no upsert', async () => {
    await h.controller.define(context, owner(), {
      key: 'points',
      name: 'Points',
      fieldType: 'number',
      options: null,
    });
    const status = await statusOf(() =>
      h.controller.setValue(context, member([PROJECT]), WORK_ID, 'points', { value: 'lots' }),
    );
    expect(status).toBe(400);
    expect(h.fields.values).toHaveLength(0);
  });
});

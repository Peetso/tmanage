import { beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { WorkItemRecurrenceController } from './item-recurrence.controller.js';
import { WorkItemRecurrenceService, computeNextOccurrence } from './item-recurrence.service.js';
import type { WorkItemRecurrenceRepository } from './item-recurrence.repository.js';
import type { WorkItemsRepository } from './work-items.repository.js';
import { ApiError } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { WorkItemRecurrenceRow, WorkItemRow } from '../../common/database/schema.js';

/**
 * x257 — the fast, database-free proof of work item recurrence. It runs the controller over an
 * in-memory rule store and a fake work-item lookup, with the **real** `authorize`: the mandatory
 * refusal (freq off the allowlist → 400, no write), the resolve-then-authorize order, the
 * cross-tenant 404 (no write), the write capability gate and the pure next-occurrence arithmetic are
 * what a wiring bug would break, and none needs MySQL. The composite foreign key and the immutable
 * trigger are proved against the engine by the chain's DB suite.
 */

const ORG = '01890000-0000-7000-8000-00000000000a';
const PROJECT = '01890000-0000-7000-8000-000000000101';
const WORK_ID = '01890000-0000-7000-8000-000000000201';

const context = { organizationId: ORG } as unknown as TenantContext;

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
    title: 'Weekly status report',
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

/** In-memory recurrence store standing in for the repository, counting its writes. */
class FakeRecurrenceRepository {
  row: WorkItemRecurrenceRow | null = null;
  writes = 0;

  async findByItem() {
    return this.row;
  }
  async upsert(
    _r: unknown,
    _c: TenantContext,
    workItemId: string,
    input: { freq: string; intervalCount: number; untilAt: Date | null },
  ) {
    this.writes += 1;
    const now = new Date();
    this.row = {
      id: 'rec-1',
      organizationId: ORG,
      workItemId,
      freq: input.freq,
      intervalCount: input.intervalCount,
      untilAt: input.untilAt,
      createdAt: now,
      updatedAt: now,
    };
    return this.row;
  }
  async deleteByItem() {
    const had = this.row !== null;
    this.row = null;
    return had;
  }
}

function harness(parent: WorkItemRow | null) {
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const workItems = { findById: async () => parent } as unknown as WorkItemsRepository;
  const recurrence = new FakeRecurrenceRepository();
  const service = new WorkItemRecurrenceService(
    database,
    workItems,
    recurrence as unknown as WorkItemRecurrenceRepository,
  );
  return { controller: new WorkItemRecurrenceController(service), recurrence };
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

describe('WorkItemRecurrenceController', () => {
  let h: ReturnType<typeof harness>;

  beforeEach(() => {
    h = harness(workItem());
  });

  it('sets a recurrence rule and reads it back', async () => {
    const related = member([PROJECT]);
    const set = await h.controller.set(context, related, WORK_ID, { freq: 'weekly', interval: 2 });
    expect(set).toMatchObject({ workItemId: WORK_ID, freq: 'weekly', interval: 2, until: null });
    const read = await h.controller.get(context, related, WORK_ID);
    expect(read.recurrence).toMatchObject({ freq: 'weekly', interval: 2 });
  });

  it('refuses a freq off the allowlist with 400 and writes nothing', async () => {
    const status = await statusOf(() =>
      h.controller.set(context, member([PROJECT]), WORK_ID, { freq: 'hourly', interval: 1 }),
    );
    expect(status).toBe(400);
    expect(h.recurrence.writes).toBe(0);
    expect(h.recurrence.row).toBeNull();
  });

  it('refuses an out-of-range interval with 400 and writes nothing', async () => {
    const status = await statusOf(() =>
      h.controller.set(context, member([PROJECT]), WORK_ID, { freq: 'daily', interval: 0 }),
    );
    expect(status).toBe(400);
    expect(h.recurrence.writes).toBe(0);
  });

  it('answers 404 and writes nothing when the parent item is cross-tenant or absent', async () => {
    const { controller, recurrence } = harness(null);
    const status = await statusOf(() =>
      controller.set(context, member([PROJECT]), WORK_ID, { freq: 'daily', interval: 1 }),
    );
    expect(status).toBe(404);
    expect(recurrence.writes).toBe(0);
  });

  it('refuses the set with 403 when the caller may read the item but not update it', async () => {
    const { controller, recurrence } = harness(workItem({ state: 'archived' }));
    const status = await statusOf(() =>
      controller.set(context, member([PROJECT]), WORK_ID, { freq: 'daily', interval: 1 }),
    );
    expect(status).toBe(403);
    expect(recurrence.writes).toBe(0);
  });

  it('generate-next computes the next occurrence and never creates a work item', async () => {
    const related = member([PROJECT]);
    await h.controller.set(context, related, WORK_ID, { freq: 'daily', interval: 3 });
    const before = h.recurrence.writes;
    const next = await h.controller.generateNext(context, related, WORK_ID);
    expect(next.workItemId).toBe(WORK_ID);
    expect(next.exhausted).toBe(false);
    expect(next.nextAt).not.toBeNull();
    // generate-next reads the rule; it performs no additional write.
    expect(h.recurrence.writes).toBe(before);
  });

  it('generate-next is a 404 when the item does not recur', async () => {
    const status = await statusOf(() =>
      h.controller.generateNext(context, member([PROJECT]), WORK_ID),
    );
    expect(status).toBe(404);
  });
});

describe('computeNextOccurrence', () => {
  const from = new Date('2026-01-30T00:00:00.000Z');

  it('advances days, weeks and clamps month arithmetic', () => {
    expect(computeNextOccurrence({ freq: 'daily', intervalCount: 5, untilAt: null }, from)).toEqual(
      new Date('2026-02-04T00:00:00.000Z'),
    );
    expect(
      computeNextOccurrence({ freq: 'weekly', intervalCount: 2, untilAt: null }, from),
    ).toEqual(new Date('2026-02-13T00:00:00.000Z'));
    // Jan 30 + 1 month clamps to Feb 28 (2026 is not a leap year).
    expect(
      computeNextOccurrence({ freq: 'monthly', intervalCount: 1, untilAt: null }, from),
    ).toEqual(new Date('2026-02-28T00:00:00.000Z'));
  });

  it('returns null when the next occurrence is past the until bound', () => {
    const until = new Date('2026-02-01T00:00:00.000Z');
    expect(
      computeNextOccurrence({ freq: 'daily', intervalCount: 5, untilAt: until }, from),
    ).toBeNull();
  });
});

import { beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { WorkItemEstimateController } from './item-estimate.controller.js';
import { WorkItemEstimateService } from './item-estimate.service.js';
import type { WorkItemsRepository } from './work-items.repository.js';
import { ApiError } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { WorkItemEstimateRow, WorkItemRow } from '../../common/database/schema.js';

/**
 * x258 — the fast, database-free proof of the estimate sub-resource. It runs the controller over an
 * in-memory store and a fake work-item lookup, with the **real** `authorize`: the resolve-then-
 * authorize order, the cross-tenant 404 (no write), the read/write capability gates, the minutes
 * bound and the estimate-vs-actual variance are the behaviours a wiring bug would break, and none
 * needs MySQL. The composite foreign key, the upsert unique key and the immutability trigger are
 * proved against the real engine by the chain's DB suite, not here.
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

/** An in-memory estimate store plus a fixed logged-actual, counting its writes. */
class FakeEstimateRepository {
  row: WorkItemEstimateRow | null = null;
  upserts = 0;
  constructor(private readonly loggedMinutes = 0) {}

  async find(_r: unknown, _c: TenantContext, workItemId: string) {
    return this.row && this.row.workItemId === workItemId ? this.row : null;
  }

  async upsert(
    _r: unknown,
    _c: TenantContext,
    input: { workItemId: string; estimateMinutes: number },
  ) {
    this.upserts += 1;
    this.row = {
      id: 'estimate-1',
      organizationId: ORG,
      workItemId: input.workItemId,
      estimateMinutes: input.estimateMinutes,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    return this.row;
  }

  async sumLoggedMinutes() {
    return this.loggedMinutes;
  }
}

function harness(parent: WorkItemRow | null, loggedMinutes = 0) {
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const workItems = { findById: async () => parent } as unknown as WorkItemsRepository;
  const estimates = new FakeEstimateRepository(loggedMinutes);
  const service = new WorkItemEstimateService(
    database,
    workItems,
    estimates as unknown as ConstructorParameters<typeof WorkItemEstimateService>[2],
  );
  return { controller: new WorkItemEstimateController(service), estimates };
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

describe('WorkItemEstimateController', () => {
  let harnessed: ReturnType<typeof harness>;

  beforeEach(() => {
    harnessed = harness(workItem(), 90);
  });

  it('sets an estimate and reads it back beside the logged actual and variance', async () => {
    const { controller } = harnessed;
    const related = member([PROJECT]);

    const set = await controller.set(context, related, WORK_ID, { minutes: 240 });
    expect(set.estimateMinutes).toBe(240);
    expect(set.actualMinutes).toBe(90);
    expect(set.varianceMinutes).toBe(150);

    const read = await controller.get(context, related, WORK_ID);
    expect(read.estimateMinutes).toBe(240);
    expect(read.varianceMinutes).toBe(150);
  });

  it('reads a null estimate and zero variance when none has been set', async () => {
    const { controller } = harness(workItem(), 0);
    const read = await controller.get(context, member([PROJECT]), WORK_ID);
    expect(read.estimateMinutes).toBeNull();
    expect(read.actualMinutes).toBe(0);
    expect(read.varianceMinutes).toBeNull();
  });

  it('rejects minutes of zero, negative, non-integer or over the cap with 400 and no upsert', async () => {
    const { controller, estimates } = harnessed;
    const related = member([PROJECT]);
    for (const minutes of [0, -5, 12.5, 100_001]) {
      const status = await statusOf(() => controller.set(context, related, WORK_ID, { minutes }));
      expect(status).toBe(400);
    }
    expect(estimates.upserts).toBe(0);
  });

  it('answers 404 and writes nothing when the parent work item is cross-tenant or absent', async () => {
    const { controller, estimates } = harness(null);
    const status = await statusOf(() =>
      controller.set(context, member([PROJECT]), WORK_ID, { minutes: 60 }),
    );
    expect(status).toBe(404);
    expect(estimates.upserts).toBe(0);
  });

  it('gates the read behind read access: an unrelated member gets 404', async () => {
    const { controller } = harnessed;
    const status = await statusOf(() => controller.get(context, member([]), WORK_ID));
    expect(status).toBe(404);
  });

  it('refuses the write with 403 when the caller may read the item but not update it', async () => {
    const { controller, estimates } = harness(workItem({ state: 'archived' }));
    const status = await statusOf(() =>
      controller.set(context, member([PROJECT]), WORK_ID, { minutes: 60 }),
    );
    expect(status).toBe(403);
    expect(estimates.upserts).toBe(0);
  });
});

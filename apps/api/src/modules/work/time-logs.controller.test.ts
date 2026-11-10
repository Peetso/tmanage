import { beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { WorkTimeLogsController } from './time-logs.controller.js';
import { WorkTimeLogsService } from './time-logs.service.js';
import type { WorkItemsRepository } from './work-items.repository.js';
import { ApiError } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { WorkItemRow, WorkItemTimeLogRow } from '../../common/database/schema.js';

/**
 * x231 — the fast, database-free proof of the time-log sub-resource. It runs the controller over an
 * in-memory store and a fake work-item lookup, with the **real** `authorize`: the resolve-then-
 * authorize order, the cross-tenant 404 (no write), the read/write capability gates, the minutes
 * bound, the summed total and the "delete only your own" rule are the behaviours a wiring bug would
 * break, and none needs MySQL. The composite foreign key and the immutability trigger are proved
 * against the real engine by the chain's DB suite, not here.
 */

const ORG = '01890000-0000-7000-8000-00000000000a';
const PROJECT = '01890000-0000-7000-8000-000000000101';
const WORK_ID = '01890000-0000-7000-8000-000000000201';
const MEMBERSHIP = '01890000-0000-7000-8000-000000000011';
const OTHER_MEMBERSHIP = '01890000-0000-7000-8000-000000000012';

const context = { organizationId: ORG } as unknown as TenantContext;

/** An internal member related to exactly the projects listed. */
function member(projectIds: readonly string[], membershipId: string = MEMBERSHIP): Principal {
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

/** An in-memory time-log store standing in for the repository, counting its writes. */
class FakeTimeLogsRepository {
  readonly rows: WorkItemTimeLogRow[] = [];
  creates = 0;
  deletes = 0;
  /** Automatic time already filed for the caller (review L3). */
  readonly automatic: { startedAt: Date; endedAt: Date }[] = [];

  async automaticOverlaps(_r: unknown, _c: TenantContext, _m: string, from: Date, to: Date) {
    return this.automatic.some((a) => a.startedAt < to && a.endedAt > from);
  }

  async findEntry(_r: unknown, _c: TenantContext, workItemId: string, entryId: string) {
    return this.rows.find((row) => row.workItemId === workItemId && row.id === entryId) ?? null;
  }

  async listForWorkItem(_r: unknown, _c: TenantContext, workItemId: string) {
    return this.rows.filter((row) => row.workItemId === workItemId);
  }

  async create(
    _r: unknown,
    _c: TenantContext,
    input: {
      workItemId: string;
      loggedBy: string;
      minutes: number;
      spentOn: string;
      note: string | null;
    },
  ) {
    this.creates += 1;
    const row: WorkItemTimeLogRow = {
      id: `entry-${this.rows.length + 1}`,
      organizationId: ORG,
      workItemId: input.workItemId,
      loggedBy: input.loggedBy,
      minutes: input.minutes,
      spentOn: input.spentOn,
      note: input.note,
      createdAt: new Date(),
      projectId: null,
      startedAt: null,
      endedAt: null,
      billable: true,
      source: 'manual',
      needsReview: false,
      updatedAt: null,
      updatedBy: null,
      lockedAt: null,
      timesheetId: null,
    };
    this.rows.push(row);
    return row;
  }

  async remove(_r: unknown, _c: TenantContext, workItemId: string, entryId: string) {
    const before = this.rows.length;
    for (let i = this.rows.length - 1; i >= 0; i -= 1) {
      if (this.rows[i]?.workItemId === workItemId && this.rows[i]?.id === entryId) {
        this.rows.splice(i, 1);
      }
    }
    if (this.rows.length < before) this.deletes += 1;
  }
}

function harness(parent: WorkItemRow | null) {
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const workItems = { findById: async () => parent } as unknown as WorkItemsRepository;
  const timeLogs = new FakeTimeLogsRepository();
  const service = new WorkTimeLogsService(
    database,
    workItems,
    timeLogs as unknown as ConstructorParameters<typeof WorkTimeLogsService>[2],
  );
  return { controller: new WorkTimeLogsController(service), timeLogs };
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

describe('WorkTimeLogsController', () => {
  let harnessed: ReturnType<typeof harness>;

  beforeEach(() => {
    harnessed = harness(workItem());
  });

  it('logs, lists with a summed total, and deletes an own entry', async () => {
    const { controller, timeLogs } = harnessed;
    const related = member([PROJECT]);

    const first = await controller.add(context, related, WORK_ID, {
      minutes: 90,
      spentOn: '2026-09-20',
      note: 'Layout pass',
    });
    await controller.add(context, related, WORK_ID, {
      minutes: 30,
      spentOn: '2026-09-21',
      note: null,
    });

    const listed = await controller.list(context, related, WORK_ID);
    expect(listed.entries).toHaveLength(2);
    expect(listed.totalMinutes).toBe(120);

    await controller.remove(context, related, WORK_ID, first.id);
    expect(timeLogs.deletes).toBe(1);
    const after = await controller.list(context, related, WORK_ID);
    expect(after.totalMinutes).toBe(30);
  });

  it('refuses a timed entry over time the computer already recorded automatically (review L3)', async () => {
    const { controller, timeLogs } = harnessed;
    const related = member([PROJECT]);
    const hour = 3_600_000;
    const base = Math.floor(Date.now() / hour) * hour - 5 * hour;
    const iso = (offsetMinutes: number) => new Date(base + offsetMinutes * 60_000).toISOString();
    timeLogs.automatic.push({ startedAt: new Date(base), endedAt: new Date(base + hour) });
    await expect(
      controller.add(context, related, WORK_ID, {
        startedAt: iso(30),
        endedAt: iso(90),
        note: null,
      }),
    ).rejects.toMatchObject({ status: 409, code: 'conflict' });
    expect(timeLogs.creates).toBe(0);
    // Right after the automatic stretch is fine; so is an entry without times.
    await controller.add(context, related, WORK_ID, {
      startedAt: iso(60),
      endedAt: iso(90),
      note: null,
    });
    await controller.add(context, related, WORK_ID, {
      minutes: 15,
      spentOn: '2026-09-20',
      note: null,
    });
    expect(timeLogs.creates).toBe(2);
  });

  it('rejects minutes of zero, negative, non-integer or over the daily cap with 400 and no write', async () => {
    const { controller, timeLogs } = harnessed;
    const related = member([PROJECT]);
    for (const minutes of [0, -5, 12.5, 24 * 60 + 1]) {
      const status = await statusOf(() =>
        controller.add(context, related, WORK_ID, { minutes, spentOn: '2026-09-20', note: null }),
      );
      expect(status).toBe(400);
    }
    expect(timeLogs.creates).toBe(0);
  });

  it('rejects a spentOn that is not a YYYY-MM-DD calendar day with 400', async () => {
    const { controller } = harnessed;
    const status = await statusOf(() =>
      controller.add(context, member([PROJECT]), WORK_ID, {
        minutes: 15,
        spentOn: 'yesterday',
        note: null,
      }),
    );
    expect(status).toBe(400);
  });

  it('answers 404 and writes nothing when the parent work item is cross-tenant or absent', async () => {
    const { controller, timeLogs } = harness(null);
    const status = await statusOf(() =>
      controller.add(context, member([PROJECT]), WORK_ID, {
        minutes: 15,
        spentOn: '2026-09-20',
        note: null,
      }),
    );
    expect(status).toBe(404);
    expect(timeLogs.creates).toBe(0);
  });

  it('gates the list behind read access: an unrelated member gets 404', async () => {
    const { controller } = harnessed;
    const status = await statusOf(() => controller.list(context, member([]), WORK_ID));
    expect(status).toBe(404);
  });

  it('refuses the write with 403 when the caller may read the item but not update it', async () => {
    const { controller, timeLogs } = harness(workItem({ state: 'archived' }));
    const status = await statusOf(() =>
      controller.add(context, member([PROJECT]), WORK_ID, {
        minutes: 15,
        spentOn: '2026-09-20',
        note: null,
      }),
    );
    expect(status).toBe(403);
    expect(timeLogs.creates).toBe(0);
  });

  it('lets a member delete only their own entry: another member is refused 403 and nothing is removed', async () => {
    const { controller, timeLogs } = harnessed;
    const owner = member([PROJECT], MEMBERSHIP);
    const logged = await controller.add(context, owner, WORK_ID, {
      minutes: 45,
      spentOn: '2026-09-20',
      note: null,
    });

    const other = member([PROJECT], OTHER_MEMBERSHIP);
    const status = await statusOf(() => controller.remove(context, other, WORK_ID, logged.id));
    expect(status).toBe(403);
    expect(timeLogs.deletes).toBe(0);
    expect(timeLogs.rows).toHaveLength(1);
  });
});

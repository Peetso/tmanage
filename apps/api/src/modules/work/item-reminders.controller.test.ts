import { beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { WorkItemRemindersController } from './item-reminders.controller.js';
import { WorkItemRemindersService } from './item-reminders.service.js';
import type { WorkItemsRepository } from './work-items.repository.js';
import { ApiError } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { WorkItemReminderRow, WorkItemRow } from '../../common/database/schema.js';

/**
 * x256 — the fast, database-free proof of the reminder sub-resource. It runs the controller over an
 * in-memory reminder store and a fake work-item lookup, with the **real** `authorize`: the
 * resolve-then-authorize order, the cross-tenant 404 (no upsert), the idempotent upsert and the
 * own-only, email-free projection are the behaviours a wiring bug would break, and none needs MySQL.
 * The composite foreign key and the unique key are proved against the real engine by the chain's DB
 * suite, not here.
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
    deletedByUserId: null,
    deletedReason: null,
    purgeAfter: null,
    ...over,
  };
}

/** An in-memory reminder store standing in for the repository, counting its writes. */
class FakeRemindersRepository {
  readonly rows: WorkItemReminderRow[] = [];
  upserts = 0;
  deletes = 0;
  /** The work item the reminders join to, as it is now (tests change it to simulate a revoke). */
  item: WorkItemRow | null = null;

  async findForMember(_r: unknown, _c: TenantContext, workItemId: string, membershipId: string) {
    return (
      this.rows.find((r) => r.workItemId === workItemId && r.membershipId === membershipId) ?? null
    );
  }

  async upsert(
    _r: unknown,
    _c: TenantContext,
    input: { workItemId: string; membershipId: string; remindAt: Date },
  ) {
    this.upserts += 1;
    const existing = this.rows.find(
      (r) => r.workItemId === input.workItemId && r.membershipId === input.membershipId,
    );
    if (existing) {
      const moved = { ...existing, remindAt: input.remindAt, updatedAt: new Date() };
      this.rows[this.rows.indexOf(existing)] = moved;
      return moved;
    }
    const row: WorkItemReminderRow = {
      id: `rem-${this.rows.length + 1}`,
      organizationId: ORG,
      workItemId: input.workItemId,
      membershipId: input.membershipId,
      remindAt: input.remindAt,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.rows.push(row);
    return row;
  }

  async deleteForMember(_r: unknown, _c: TenantContext, workItemId: string, membershipId: string) {
    this.deletes += 1;
    const at = this.rows.findIndex(
      (r) => r.workItemId === workItemId && r.membershipId === membershipId,
    );
    if (at >= 0) this.rows.splice(at, 1);
  }

  async listDueForMember(_r: unknown, _c: TenantContext, membershipId: string, before: Date) {
    return this.rows
      .filter((r) => r.membershipId === membershipId && r.remindAt.getTime() <= before.getTime())
      .sort((a, b) => a.remindAt.getTime() - b.remindAt.getTime())
      .flatMap((reminder) => {
        // The joined item as it is *now*. The fake does not drop soft-deleted items, so the
        // service's own F57 re-check is what the tests below prove.
        const item = this.item;
        if (!item || item.id !== reminder.workItemId) return [];
        return [{ reminder, workItemTitle: item.title, workItemState: item.state, workItem: item }];
      });
  }
}

function harness(parent: WorkItemRow | null) {
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const workItems = { findById: async () => parent } as unknown as WorkItemsRepository;
  const reminders = new FakeRemindersRepository();
  reminders.item = parent;
  const service = new WorkItemRemindersService(
    database,
    workItems,
    reminders as unknown as ConstructorParameters<typeof WorkItemRemindersService>[2],
  );
  return { controller: new WorkItemRemindersController(service), reminders };
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

describe('WorkItemRemindersController', () => {
  let harnessed: ReturnType<typeof harness>;

  beforeEach(() => {
    harnessed = harness(workItem());
  });

  it('sets a reminder with no email in the projection and upserts on repeat', async () => {
    const { controller, reminders } = harnessed;
    const related = member([PROJECT]);

    const first = await controller.set(context, related, WORK_ID, {
      remindAt: '2026-10-01T09:00:00.000Z',
    });
    expect(first).toMatchObject({ workItemId: WORK_ID, membershipId: MEMBERSHIP });
    expect(Object.keys(first).sort()).toEqual([
      'createdAt',
      'id',
      'membershipId',
      'remindAt',
      'updatedAt',
      'workItemId',
    ]);

    const again = await controller.set(context, related, WORK_ID, {
      remindAt: '2026-11-02T09:00:00.000Z',
    });
    expect(again.id).toBe(first.id);
    expect(again.remindAt).toBe('2026-11-02T09:00:00.000Z');
    expect(reminders.rows).toHaveLength(1);
    expect(reminders.upserts).toBe(2);
  });

  it('rejects a non-date remindAt with 400 and writes nothing', async () => {
    const { controller, reminders } = harnessed;
    const status = await statusOf(() =>
      controller.set(context, member([PROJECT]), WORK_ID, { remindAt: 'not-a-date' }),
    );
    expect(status).toBe(400);
    expect(reminders.upserts).toBe(0);
  });

  it('lists only the acting member’s due reminders, soonest first', async () => {
    const { controller } = harnessed;
    const related = member([PROJECT]);
    await controller.set(context, related, WORK_ID, { remindAt: '2026-10-01T09:00:00.000Z' });

    const due = await controller.listDue(context, related, '2026-12-31T00:00:00.000Z');
    expect(due.reminders).toHaveLength(1);
    expect(due.reminders[0]).toMatchObject({ workItemId: WORK_ID, membershipId: MEMBERSHIP });

    // A `before` earlier than the reminder excludes it.
    const none = await controller.listDue(context, related, '2026-01-01T00:00:00.000Z');
    expect(none.reminders).toHaveLength(0);
  });

  it('answers 404 and upserts nothing when the parent work item is cross-tenant or absent', async () => {
    const { controller, reminders } = harness(null);
    const status = await statusOf(() =>
      controller.set(context, member([PROJECT]), WORK_ID, { remindAt: '2026-10-01T09:00:00.000Z' }),
    );
    expect(status).toBe(404);
    expect(reminders.upserts).toBe(0);
  });
});

describe('F57: the due list re-authorizes each reminder’s item', () => {
  const DUE_BEFORE = '2026-12-31T00:00:00.000Z';

  async function withReminder() {
    const harnessed = harness(workItem());
    await harnessed.controller.set(context, member([PROJECT]), WORK_ID, {
      remindAt: '2026-10-01T09:00:00.000Z',
    });
    return harnessed;
  }

  it('drops the reminder once the member is removed from the project', async () => {
    const { controller, reminders } = await withReminder();
    reminders.item = workItem({ title: 'RENAMED-AFTER-REVOKE' });
    const due = await controller.listDue(context, member([]), DUE_BEFORE);
    expect(due.reminders).toEqual([]);
    expect(JSON.stringify(due)).not.toContain('RENAMED-AFTER-REVOKE');
  });

  it('drops the reminder once the item moves to a project the member is not on', async () => {
    const { controller, reminders } = await withReminder();
    reminders.item = workItem({ projectId: '01890000-0000-7000-8000-000000000102' });
    expect((await controller.listDue(context, member([PROJECT]), DUE_BEFORE)).reminders).toEqual(
      [],
    );
  });

  it('drops the reminder once the item is soft-deleted', async () => {
    const { controller, reminders } = await withReminder();
    reminders.item = workItem({ deletedAt: new Date() });
    expect((await controller.listDue(context, member([PROJECT]), DUE_BEFORE)).reminders).toEqual(
      [],
    );
  });
});

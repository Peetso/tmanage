import { describe, expect, it } from 'vitest';
import { runRule } from '../../consumers/automation-runs.js';
import type { TriggerObject } from '../../consumers/automation-runs.js';
import type { WorkerTransaction } from './worker-database.js';
import {
  deliverHeldRuns,
  HELD_RUN_MAX_AGE_DAYS,
  listWeekendRules,
  undeliveredHeldRuns,
} from './weekend-hold-store.js';
import type { WeekendRule } from './weekend-hold-store.js';

/**
 * Gap 10 — a "Skip weekends" rule holds its Friday/Saturday runs, and the due-soon sweep delivers
 * them on Sunday morning in the company's timezone, once. Database-free: a fake transaction keeps
 * the run history and the notifications' dedupe keys.
 */

const rule: WeekendRule = {
  id: 'rule-1',
  organizationId: 'org-1',
  name: 'Remind the owner',
  triggerKind: 'work_item_created',
  actionKind: 'notify_owner',
  skipWeekends: true,
  alsoTell: 'none',
  timeZone: 'UTC',
};

const object: TriggerObject = {
  objectType: 'work_item',
  objectId: 'item-1',
  projectId: 'project-1',
  ownerIds: ['user-1'],
};

const FRIDAY = new Date(Date.UTC(2026, 9, 23, 10));
const SATURDAY = new Date(Date.UTC(2026, 9, 24, 15));
const SUNDAY_EARLY = new Date(Date.UTC(2026, 9, 25, 6));
const SUNDAY_MORNING = new Date(Date.UTC(2026, 9, 25, 8, 1));

interface Run {
  readonly id: string;
  readonly status: string;
  readonly detail: Record<string, unknown>;
}

function fakeDb(options: { owner?: string | null; itemGone?: boolean } = {}) {
  const runs: Run[] = [];
  const notices = new Map<string, string>();
  const windows: unknown[] = [];
  const tx: WorkerTransaction = {
    query: async <T>(sql: string, params: readonly unknown[] = []): Promise<T> => {
      if (/SELECT timezone FROM organizations/.test(sql)) return [{ timezone: 'UTC' }] as T;
      if (/FROM org_working_calendars/.test(sql)) return [] as T;
      if (/FROM workflow_runs/.test(sql)) {
        windows.push(params[2]);
        return runs
          .filter((run) => params[0] === 'org-1' && run.detail['templateId'] === params[1])
          .map((run) => ({ id: run.id, detail_json: JSON.stringify(run.detail) })) as T;
      }
      if (/INSERT INTO workflow_runs/.test(sql)) {
        runs.push({
          id: String(params[0]),
          status: String(params[3]),
          detail: JSON.parse(String(params[4])) as Record<string, unknown>,
        });
        return { affectedRows: 1 } as T;
      }
      if (/FROM work_items/.test(sql)) {
        if (options.itemGone === true) return [] as T;
        return [
          {
            title: 'Brief',
            project_id: 'project-1',
            owner_user_id: options.owner === undefined ? 'user-2' : options.owner,
            audience: 'internal',
          },
        ] as T;
      }
      if (/FROM memberships m/.test(sql)) {
        return [{ id: 'm', role: 'owner', has_org_wide_scope: 1, on_project: 1 }] as T;
      }
      if (/INSERT INTO notifications/.test(sql)) {
        const key = `${String(params[2])}|${String(params[6])}`;
        if (notices.has(key)) return { affectedRows: 0 } as T;
        notices.set(key, String(params[5]));
        return { affectedRows: 1 } as T;
      }
      throw new Error(`unexpected statement: ${sql}`);
    },
  };
  return { tx, runs, notices, windows };
}

async function holdOne(tx: WorkerTransaction, eventId: string, at: Date): Promise<void> {
  await runRule({ id: eventId, organizationId: 'org-1' }, tx, rule, object, at);
}

describe('weekend-held runs are delivered on Sunday morning (gap 10)', () => {
  it('holds on Friday and Saturday, waits through early Sunday, then delivers each once', async () => {
    const db = fakeDb();
    await holdOne(db.tx, 'event-fri', FRIDAY);
    await holdOne(db.tx, 'event-sat', SATURDAY);
    expect(db.notices.size).toBe(0);
    expect(db.runs.map((run) => run.detail['reason'])).toEqual([
      'held_for_weekend',
      'held_for_weekend',
    ]);

    expect(await deliverHeldRuns(db.tx, rule, SATURDAY)).toBe(0);
    expect(await deliverHeldRuns(db.tx, rule, SUNDAY_EARLY)).toBe(0);
    expect(db.notices.size).toBe(0);

    expect(await deliverHeldRuns(db.tx, rule, SUNDAY_MORNING)).toBe(2);
    // The current owner hears it, under the dedupe key the run would have used on the day.
    expect([...db.notices.keys()]).toEqual([
      'user-2|automation:rule-1:event-fri',
      'user-2|automation:rule-1:event-sat',
    ]);
    const delivered = db.runs.slice(2);
    expect(delivered.map((run) => run.status)).toEqual(['succeeded', 'succeeded']);
    expect(delivered.map((run) => run.detail['heldRunId'])).toEqual([
      db.runs[0]!.id,
      db.runs[1]!.id,
    ]);
    expect(delivered[0]!.detail['effect']).toBe(
      'Notified the owner in their inbox on Sunday morning, after the weekend.',
    );
    expect(db.windows).toContain(HELD_RUN_MAX_AGE_DAYS);

    // Idempotent: the next sweep minutes later finds every held run closed.
    expect(await deliverHeldRuns(db.tx, rule, SUNDAY_MORNING)).toBe(0);
    expect(db.runs).toHaveLength(4);
    expect(db.notices.size).toBe(2);
  });

  it("waits for Sunday 08:00 on the company's clock", async () => {
    const db = fakeDb();
    await holdOne(db.tx, 'event-sat', SATURDAY);
    // 06:00 UTC on Sunday is 09:00 in Riyadh and 02:00 in New York.
    expect(
      await deliverHeldRuns(db.tx, { ...rule, timeZone: 'America/New_York' }, SUNDAY_EARLY),
    ).toBe(0);
    expect(await deliverHeldRuns(db.tx, { ...rule, timeZone: 'Asia/Riyadh' }, SUNDAY_EARLY)).toBe(
      1,
    );
  });

  it('records nothing twice when a racing sweep already sent the notices', async () => {
    const db = fakeDb();
    await holdOne(db.tx, 'event-fri', FRIDAY);
    db.notices.set('user-2|automation:rule-1:event-fri', 'item-1');
    expect(await deliverHeldRuns(db.tx, rule, SUNDAY_MORNING)).toBe(1);
    expect(db.runs).toHaveLength(1);
  });

  it('closes a held run whose work item is gone without telling anyone', async () => {
    const db = fakeDb({ itemGone: true });
    await holdOne(db.tx, 'event-fri', FRIDAY);
    expect(await deliverHeldRuns(db.tx, rule, SUNDAY_MORNING)).toBe(1);
    expect(db.notices.size).toBe(0);
    expect(db.runs[1]!.detail).toMatchObject({
      outcome: 'not_run',
      reason: 'trigger_object_gone',
      heldRunId: db.runs[0]!.id,
    });
    expect(await deliverHeldRuns(db.tx, rule, SUNDAY_MORNING)).toBe(0);
  });
});

describe('undeliveredHeldRuns', () => {
  it('skips closed runs and runs held before gap 10 recorded their object', () => {
    const held = (id: string, extra: Record<string, unknown> = {}) => ({
      id,
      detail_json: {
        reason: 'held_for_weekend',
        heldEventId: `e-${id}`,
        heldObjectType: 'meeting',
        heldObjectId: `m-${id}`,
        heldProjectId: 'p',
        ...extra,
      },
    });
    const rows = [
      held('a'),
      held('b'),
      { id: 'old', detail_json: '{"reason":"held_for_weekend"}' },
      { id: 'c', detail_json: { outcome: 'executed', heldRunId: 'a' } },
    ];
    expect(undeliveredHeldRuns(rows).map((run) => run.runId)).toEqual(['b']);
  });
});

describe('listWeekendRules', () => {
  it('keeps only enabled rules that skip weekends, with the company timezone', async () => {
    const tx: WorkerTransaction = {
      query: async <T>(): Promise<T> =>
        [
          {
            id: 'r1',
            organization_id: 'org-1',
            name: 'A',
            trigger_kind: 'work_item_created',
            action_kind: 'notify_owner',
            config_json: '{"skipWeekends":true,"alsoTell":"project_lead"}',
            timezone: 'Asia/Riyadh',
          },
          {
            id: 'r2',
            organization_id: 'org-1',
            name: 'B',
            trigger_kind: 'work_item_created',
            action_kind: 'notify_owner',
            config_json: { skipWeekends: false },
            timezone: 'Asia/Riyadh',
          },
          {
            id: 'r3',
            organization_id: 'org-2',
            name: 'C',
            trigger_kind: 'meeting_scheduled',
            action_kind: 'notify_owner',
            config_json: { skipWeekends: true },
            timezone: null,
          },
        ] as T,
    };
    const rules = await listWeekendRules(tx);
    expect(rules.map((r) => [r.id, r.timeZone, r.alsoTell])).toEqual([
      ['r1', 'Asia/Riyadh', 'project_lead'],
      ['r3', 'UTC', 'none'],
    ]);
  });
});

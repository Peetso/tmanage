import { describe, expect, it } from 'vitest';
import { isHeldForWeekend, isWeekendHoldReleased, localClock, runRule } from './automation-runs.js';
import type { TriggerObject } from './automation-runs.js';
import type { AutomationRule } from '../common/database/collaboration-store.js';
import type { WorkerTransaction } from '../common/database/worker-database.js';

/**
 * A14 — "Skip weekends" on the automation rule page. The studio week ends on Friday and Saturday,
 * so a rule with the option on holds its reminder on those two days and sends it on every other.
 */
describe('isHeldForWeekend', () => {
  // 2026-10-19 is a Monday; the next six days run Tuesday … Sunday.
  const week = [19, 20, 21, 22, 23, 24, 25].map((day) => new Date(Date.UTC(2026, 9, day, 9)));

  it('holds only Friday and Saturday when the rule skips weekends', () => {
    expect(week.map((at) => isHeldForWeekend(true, at))).toEqual([
      false, // Monday
      false, // Tuesday
      false, // Wednesday
      false, // Thursday
      true, // Friday
      true, // Saturday
      false, // Sunday
    ]);
  });

  it('never holds a reminder when the option is off', () => {
    expect(week.some((at) => isHeldForWeekend(false, at))).toBe(false);
  });

  it("reads the day on the company's clock, not UTC", () => {
    // Thursday 22:30 UTC is already Friday 01:30 in Riyadh, and Saturday 22:30 UTC is Sunday there.
    expect(isHeldForWeekend(true, new Date(Date.UTC(2026, 9, 22, 22, 30)), 'Asia/Riyadh')).toBe(
      true,
    );
    expect(isHeldForWeekend(true, new Date(Date.UTC(2026, 9, 24, 22, 30)), 'Asia/Riyadh')).toBe(
      false,
    );
    // An unknown zone reads as UTC.
    expect(localClock(new Date(Date.UTC(2026, 9, 23, 9)), 'Not/AZone')).toEqual({
      day: 5,
      hour: 9,
    });
  });
});

/** Gap 10 — held runs go out from Sunday 08:00 on the company's clock. */
describe('isWeekendHoldReleased', () => {
  it('waits through Friday, Saturday and early Sunday, then releases', () => {
    const at = (day: number, hour: number) => new Date(Date.UTC(2026, 9, day, hour));
    expect(isWeekendHoldReleased(at(23, 12), 'UTC')).toBe(false); // Friday
    expect(isWeekendHoldReleased(at(24, 23), 'UTC')).toBe(false); // Saturday night
    expect(isWeekendHoldReleased(at(25, 7), 'UTC')).toBe(false); // Sunday 07:00
    expect(isWeekendHoldReleased(at(25, 8), 'UTC')).toBe(true); // Sunday 08:00
    expect(isWeekendHoldReleased(at(26, 3), 'UTC')).toBe(true); // a sweep that missed Sunday
  });

  it('is Sunday morning in the company timezone', () => {
    // 05:00 UTC on Sunday is 08:00 in Riyadh (UTC+3), but only 01:00 in New York.
    const sunday5utc = new Date(Date.UTC(2026, 9, 25, 5));
    expect(isWeekendHoldReleased(sunday5utc, 'Asia/Riyadh')).toBe(true);
    expect(isWeekendHoldReleased(sunday5utc, 'America/New_York')).toBe(false);
  });
});

/**
 * The rule page says "No reminders are sent on Friday or Saturday". A held run tells nobody and
 * records why, so the run history explains the quiet day.
 */
describe('runRule on a held weekend day', () => {
  const rule: AutomationRule = {
    id: 'rule-1',
    name: 'Remind the owner',
    triggerKind: 'work_item_created',
    actionKind: 'notify_owner',
    skipWeekends: true,
    alsoTell: 'none',
  };
  const object: TriggerObject = {
    objectType: 'work_item',
    objectId: 'item-1',
    projectId: 'project-1',
    ownerIds: ['user-1'],
  };

  function recordingTx(
    timezone = 'UTC',
    calendar: unknown = [],
  ): {
    tx: WorkerTransaction;
    statements: string[];
    params: unknown[][];
  } {
    const statements: string[] = [];
    const params: unknown[][] = [];
    const tx: WorkerTransaction = {
      query: <T>(sql: string, values: readonly unknown[] = []): Promise<T> => {
        statements.push(sql);
        params.push([...values]);
        if (/FROM organizations/.test(sql)) return Promise.resolve([{ timezone }] as T);
        if (/FROM org_working_calendars/.test(sql)) return Promise.resolve(calendar as T);
        return Promise.resolve({ affectedRows: 1 } as T);
      },
    };
    return { tx, statements, params };
  }

  it.each([
    ['Friday', 23],
    ['Saturday', 24],
  ])('sends nothing on %s and records held_for_weekend', async (_day, date) => {
    const { tx, statements, params } = recordingTx();
    await runRule(
      { id: 'event-1', organizationId: 'org-1' },
      tx,
      rule,
      object,
      new Date(Date.UTC(2026, 9, date, 9)),
    );
    expect(statements.some((sql) => /INSERT INTO notifications/.test(sql))).toBe(false);
    expect(statements).toHaveLength(3);
    expect(statements[0]).toMatch(/SELECT timezone FROM organizations/);
    expect(params[0]).toEqual(['org-1']);
    expect(statements[1]).toMatch(/FROM org_working_calendars/);
    expect(statements[2]).toMatch(/INSERT INTO workflow_runs/);
    const detail = JSON.parse(String(params[2]?.[4])) as Record<string, unknown>;
    // Gap 10: the held run keeps what the Sunday delivery needs to send it.
    expect(detail).toMatchObject({
      outcome: 'not_run',
      reason: 'held_for_weekend',
      heldEventId: 'event-1',
      heldObjectType: 'work_item',
      heldObjectId: 'item-1',
      heldProjectId: 'project-1',
    });
  });

  it("holds on the company's Friday even while UTC is still Thursday", async () => {
    // Thursday 23:00 UTC: Thursday in UTC (sent), Friday 02:00 in Riyadh (held).
    const at = new Date(Date.UTC(2026, 9, 22, 23));
    const reasonOf = (r: { statements: string[]; params: unknown[][] }) => {
      const index = r.statements.findIndex((sql) => /INSERT INTO workflow_runs/.test(sql));
      return (JSON.parse(String(r.params[index]?.[4])) as Record<string, unknown>)['reason'];
    };
    const utc = recordingTx('UTC');
    await runRule({ id: 'event-1', organizationId: 'org-1' }, utc.tx, rule, object, at);
    expect(reasonOf(utc)).not.toBe('held_for_weekend');

    const riyadh = recordingTx('Asia/Riyadh');
    await runRule({ id: 'event-1', organizationId: 'org-1' }, riyadh.tx, rule, object, at);
    expect(reasonOf(riyadh)).toBe('held_for_weekend');
  });

  it("holds on a Mon–Fri company calendar's Sunday (no Fri–Sat fallback)", async () => {
    const monFri = [
      { id: 'cal-1', working_days_mask: 62, day_start: '09:00:00', time_zone: 'UTC' },
    ];
    const r = recordingTx('UTC', monFri);
    const sunday = new Date(Date.UTC(2026, 9, 25, 9));
    await runRule({ id: 'event-1', organizationId: 'org-1' }, r.tx, rule, object, sunday);
    const index = r.statements.findIndex((sql) => /INSERT INTO workflow_runs/.test(sql));
    expect(JSON.parse(String(r.params[index]?.[4]))).toMatchObject({ reason: 'held_for_weekend' });
  });

  it('does not read the company clock for a rule that does not skip weekends', async () => {
    const { tx, statements } = recordingTx();
    await runRule(
      { id: 'event-1', organizationId: 'org-1' },
      tx,
      { ...rule, skipWeekends: false },
      object,
      new Date(Date.UTC(2026, 9, 23, 9)),
    );
    expect(statements.some((sql) => /FROM organizations/.test(sql))).toBe(false);
  });
});

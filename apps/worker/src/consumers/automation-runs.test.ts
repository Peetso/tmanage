import { describe, expect, it } from 'vitest';
import { isHeldForWeekend, runRule } from './automation-runs.js';
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

  function recordingTx(): { tx: WorkerTransaction; statements: string[]; params: unknown[][] } {
    const statements: string[] = [];
    const params: unknown[][] = [];
    const tx: WorkerTransaction = {
      query: <T>(sql: string, values: readonly unknown[] = []): Promise<T> => {
        statements.push(sql);
        params.push([...values]);
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
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatch(/INSERT INTO workflow_runs/);
    const detail = JSON.parse(String(params[0]?.[4])) as Record<string, unknown>;
    expect(detail).toMatchObject({ outcome: 'not_run', reason: 'held_for_weekend' });
  });
});

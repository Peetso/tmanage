import { describe, expect, it } from 'vitest';
import { DEFAULT_DUE_IN_DAYS, dueInDaysOf, sweepDueSoon } from './due-soon-sweeper.js';
import type { DueSoonRule } from './due-soon-sweeper.js';
import { fireDueSoonRule } from '../common/database/due-soon-store.js';
import type { WorkerTransaction } from '../common/database/worker-database.js';
import { selectWorkerCommand, workerModeFor } from '../cli.js';

/**
 * C1 — the "work item due in N days" trigger. Database-free: a fake transaction holds the claim
 * table's unique key, so a second sweep on the same day proves the idempotency.
 */

const rule: DueSoonRule = {
  id: 'rule-1',
  organizationId: 'org-1',
  name: 'Remind the owner before the due date',
  triggerKind: 'work_item_due_soon',
  actionKind: 'notify_owner',
  skipWeekends: false,
  alsoTell: 'none',
  dueInDays: 2,
};

/** Monday 2026-10-19, so no weekend hold is in play. */
const MONDAY = new Date(Date.UTC(2026, 9, 19, 9));

function fakeTx(conditions: readonly { field: string; op: string; value: string }[] = []) {
  const claims = new Set<string>();
  const runs: string[] = [];
  const windows: unknown[] = [];
  const tx: WorkerTransaction = {
    query: async <T>(sql: string, params: readonly unknown[] = []): Promise<T> => {
      if (/FROM work_items/.test(sql) && /due_at/.test(sql)) {
        windows.push(params[1]);
        return [
          { id: 'item-1', project_id: 'project-1', owner_user_id: 'user-1', state: 'in_progress' },
          { id: 'item-2', project_id: 'project-2', owner_user_id: 'user-2', state: 'ready' },
        ] as T;
      }
      if (/FROM workflow_conditions/.test(sql)) return conditions as T;
      if (/INSERT IGNORE INTO workflow_due_soon_fires/.test(sql)) {
        const key = `${String(params[2])}:${String(params[3])}:today`;
        if (claims.has(key)) return { affectedRows: 0 } as T;
        claims.add(key);
        return { affectedRows: 1 } as T;
      }
      if (/FROM memberships m/.test(sql)) {
        return [{ id: 'm', role: 'owner', has_org_wide_scope: 1, on_project: 1 }] as T;
      }
      if (/INSERT INTO notifications/.test(sql)) return { affectedRows: 1 } as T;
      if (/INSERT INTO workflow_runs/.test(sql)) {
        runs.push(String(params[3]));
        return { affectedRows: 1 } as T;
      }
      throw new Error(`unexpected statement: ${sql}`);
    },
  };
  return { tx, runs, windows };
}

describe('due-soon trigger (C1)', () => {
  it('defaults to 2 days and accepts only a whole number from 1 to 30', () => {
    expect(DEFAULT_DUE_IN_DAYS).toBe(2);
    expect(dueInDaysOf({})).toBe(2);
    expect(dueInDaysOf({ dueInDays: 5 })).toBe(5);
    for (const bad of [0, 31, 1.5, '3', null]) expect(dueInDaysOf({ dueInDays: bad })).toBe(2);
  });

  it('runs the rule once per due item, and not again the same day', async () => {
    const { tx, runs, windows } = fakeTx();
    expect(await fireDueSoonRule(tx, rule, MONDAY)).toBe(2);
    expect(runs).toEqual(['succeeded', 'succeeded']);
    // The window ends at the end of the day two days out: CURRENT_DATE + 3 days, exclusive.
    expect(windows).toEqual([3]);

    expect(await fireDueSoonRule(tx, rule, MONDAY)).toBe(0);
    expect(runs).toHaveLength(2);
  });

  it('skips items the rule conditions do not match', async () => {
    const { tx, runs } = fakeTx([{ field: 'project_id', op: 'eq', value: 'project-2' }]);
    expect(await fireDueSoonRule(tx, rule, MONDAY)).toBe(1);
    expect(runs).toEqual(['succeeded']);
  });

  it('sweeps every rule the store lists and totals what fired', async () => {
    const fired: string[] = [];
    const result = await sweepDueSoon({
      listRules: async () => [rule, { ...rule, id: 'rule-2' }],
      fireRule: async (r) => {
        fired.push(r.id);
        return 3;
      },
      deliverHeldRuns: async () => {
        fired.push('held');
        return 1;
      },
    });
    // Gap 10: the same sweep then delivers the weekend-held runs.
    expect(fired).toEqual(['rule-1', 'rule-2', 'held']);
    expect(result).toEqual({ rules: 2, fired: 6, delivered: 1 });
  });

  it('is its own batch command, --sweep-due-soon', () => {
    const command = selectWorkerCommand(['node', 'main', '--sweep-due-soon']);
    expect(command).toEqual({ kind: 'sweep-due-soon' });
    expect(workerModeFor(command)).toBe('batch');
  });
});

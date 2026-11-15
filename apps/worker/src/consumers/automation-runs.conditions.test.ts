import { describe, expect, it } from 'vitest';
import { automationRunsConsumer } from './automation-runs.js';
import type { ClaimedOutboxEvent } from '../common/database/outbox-store.js';
import type { WorkerTransaction } from '../common/database/worker-database.js';
import type { OutboxEffects } from '../outbox/dispatcher.js';

/**
 * C1 — a rule fires only when its saved conditions match. Database-free: a fake transaction
 * answers the runner's reads by statement and records its writes.
 */

const ORG = 'org-1';
const OWNER = 'user-owner';

interface Condition {
  readonly field: string;
  readonly op: string;
  readonly value: string;
}

function fakeTx(conditions: readonly Condition[], state = 'in_progress') {
  const runs: { status: string; detail: Record<string, unknown> }[] = [];
  const notices: unknown[][] = [];
  const tx: WorkerTransaction = {
    query: async <T>(sql: string, params: readonly unknown[] = []): Promise<T> => {
      if (/FROM workflow_templates/.test(sql)) {
        return [
          {
            id: 'rule-1',
            name: 'Remind the owner',
            trigger_kind: 'work_item_created',
            action_kind: 'notify_owner',
            config_json: '{}',
          },
        ] as T;
      }
      if (/SELECT title, project_id/.test(sql)) {
        return [
          { title: 'T', project_id: 'project-1', owner_user_id: OWNER, audience: 'internal' },
        ] as T;
      }
      if (/SELECT state FROM work_items/.test(sql)) return [{ state }] as T;
      if (/FROM workflow_conditions/.test(sql)) return conditions as T;
      if (/FROM workflow_flow_versions/.test(sql)) return [] as T; // 58-C1: linear rules
      if (/FROM memberships m/.test(sql)) {
        return [{ id: 'm-1', role: 'owner', has_org_wide_scope: 1, on_project: 1 }] as T;
      }
      if (/SELECT id FROM notifications/.test(sql)) return [{ id: params[1] }] as T;
      if (/INSERT INTO notifications/.test(sql)) {
        notices.push([...params]);
        return { affectedRows: 1 } as T;
      }
      if (/INSERT INTO workflow_runs/.test(sql)) {
        runs.push({ status: String(params[3]), detail: JSON.parse(String(params[4])) });
        return { affectedRows: 1 } as T;
      }
      throw new Error(`unexpected statement: ${sql}`);
    },
  };
  return { tx, runs, notices };
}

/** The runner uses no effect (no mail, no realtime). */
const effects = {} as OutboxEffects;

const event = {
  id: 'event-1',
  organizationId: ORG,
  type: 'work_item.created.v1',
  payload: { workItemId: 'item-1' },
} as unknown as ClaimedOutboxEvent;

describe('automationRunsConsumer — rule conditions (C1)', () => {
  it('fires a rule with no conditions', async () => {
    const { tx, runs, notices } = fakeTx([]);
    await automationRunsConsumer(event, tx, effects);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe('succeeded');
    expect(notices).toHaveLength(1);
  });

  it('fires when the saved conditions match the work item', async () => {
    const { tx, runs } = fakeTx([
      { field: 'project_id', op: 'eq', value: 'project-1' },
      { field: 'status', op: 'neq', value: 'done' },
    ]);
    await automationRunsConsumer(event, tx, effects);
    expect(runs.map((run) => run.status)).toEqual(['succeeded']);
  });

  it('does not run, notify or record anything when a condition does not match', async () => {
    const { tx, runs, notices } = fakeTx([{ field: 'project_id', op: 'eq', value: 'project-2' }]);
    await automationRunsConsumer(event, tx, effects);
    expect(runs).toHaveLength(0);
    expect(notices).toHaveLength(0);
  });

  it('reads the status chip against the item state', async () => {
    const { tx, runs } = fakeTx([{ field: 'status', op: 'neq', value: 'done' }], 'done');
    await automationRunsConsumer(event, tx, effects);
    expect(runs).toHaveLength(0);
  });
});

import { describe, expect, it } from 'vitest';
import type { WorkerTransaction } from '../common/database/worker-database.js';
import type { ClaimedOutboxEvent } from '../common/database/outbox-store.js';
import type { OutboxEffects } from '../outbox/dispatcher.js';
import { organizationsWithFlagOn } from '../common/database/feature-flag-store.js';
import { fileSignals } from '../common/database/signals-store.js';
import { BUSINESS_BRIEFING_FLAG, WORK_SIGNAL_RAISED_EVENT } from '../jobs/signals-sweeper.js';
import { workSignalRaisedConsumer } from './work-signal-notice.js';

/**
 * The unit half of the signal notice path: the consumer and the store driven through a fake
 * transaction that answers each statement by its table and records every write. DB cases (one
 * notice per subject per day on a real server, grants) belong to the test phase.
 */

const ORG = '00000000-0000-4000-8000-0000000000aa';
const NOW = new Date('2026-11-19T10:00:00.000Z');

interface World {
  flagRow?: boolean;
  signal?: {
    rule_key: string;
    subject_type: string;
    subject_id: string;
    project_id: string | null;
  };
  setting?: { enabled: number; threshold: number; recipient: string };
  owner?: string | null;
  managerOfUser?: string | null;
  memberships: readonly {
    membership_id: string;
    user_id: string;
    role: string;
    has_org_wide_scope: number;
    on_project: number;
  }[];
}

function fakeTx(world: World): { tx: WorkerTransaction; notices: string[]; sql: string[] } {
  const notices: string[] = [];
  const sql: string[] = [];
  const written = new Set<string>();
  const tx: WorkerTransaction = {
    async query<T>(text: string, params: readonly unknown[] = []): Promise<T> {
      sql.push(text);
      const answer = (value: unknown) => value as T;
      if (/FROM org_feature_flags/.test(text)) {
        return answer(
          world.flagRow === undefined
            ? []
            : [{ organization_id: ORG, enabled: world.flagRow ? 1 : 0 }],
        );
      }
      if (/FROM platform_feature_flags|FROM platform_org_flag_overrides/.test(text))
        return answer([]);
      if (/FROM organizations/.test(text)) return answer([{ id: ORG }]);
      if (/FROM work_signals/.test(text)) {
        return answer(world.signal === undefined ? [] : [{ id: params[1], ...world.signal }]);
      }
      if (/FROM work_signal_settings/.test(text)) {
        return answer(
          world.setting === undefined ? [] : [{ rule_key: params[1], ...world.setting }],
        );
      }
      if (/FROM work_items/.test(text)) return answer([{ owner_user_id: world.owner ?? null }]);
      if (/FROM member_reporting_lines r/.test(text)) {
        return answer(world.managerOfUser ? [{ manager_member_id: world.managerOfUser }] : []);
      }
      if (/FROM memberships m/.test(text)) return answer(world.memberships);
      if (/INSERT INTO notifications/.test(text)) {
        written.add(String(params[0]));
        notices.push(String(params[2]));
        return answer({ affectedRows: 1 });
      }
      if (/SELECT id FROM notifications/.test(text)) {
        return answer(written.has(String(params[1])) ? [{ id: params[1] }] : []);
      }
      throw new Error(`unexpected statement: ${text}`);
    },
  };
  return { tx, notices, sql };
}

const event: ClaimedOutboxEvent = {
  id: 'evt-1',
  organizationId: ORG,
  type: WORK_SIGNAL_RAISED_EVENT,
  schemaVersion: 1,
  aggregateType: 'work_signal',
  aggregateId: 'sig-1',
  payload: { signalId: 'sig-1', rule: 'stale_task' },
  correlationId: null,
  occurredAt: NOW,
  attempts: 1,
};

/** The consumer stages no after-commit work. */
const noEffects: OutboxEffects = { afterCommit: () => {} };

const PEOPLE = [
  {
    membership_id: 'm-owner',
    user_id: 'owner',
    role: 'owner',
    has_org_wide_scope: 1,
    on_project: 0,
  },
  {
    membership_id: 'm-doer',
    user_id: 'doer',
    role: 'member',
    has_org_wide_scope: 0,
    on_project: 1,
  },
  {
    membership_id: 'm-lead',
    user_id: 'lead',
    role: 'manager',
    has_org_wide_scope: 0,
    on_project: 1,
  },
  {
    membership_id: 'm-boss',
    user_id: 'boss',
    role: 'manager',
    has_org_wide_scope: 0,
    on_project: 0,
  },
];

const stale = {
  rule_key: 'stale_task',
  subject_type: 'work_item',
  subject_id: 'w1',
  project_id: 'p1',
};

describe('workSignalRaisedConsumer', () => {
  it('tells the rule’s default recipient (the assignee for a stale task)', async () => {
    const { tx, notices } = fakeTx({
      flagRow: true,
      signal: stale,
      owner: 'doer',
      memberships: PEOPLE,
    });
    await workSignalRaisedConsumer(event, tx, noEffects);
    expect(notices).toEqual(['doer']);
  });

  it('tells the owner’s chosen recipient: their manager', async () => {
    const { tx, notices } = fakeTx({
      flagRow: true,
      signal: stale,
      setting: { enabled: 1, threshold: 14, recipient: 'their_manager' },
      owner: 'doer',
      managerOfUser: 'm-boss',
      memberships: PEOPLE,
    });
    await workSignalRaisedConsumer(event, tx, noEffects);
    expect(notices).toEqual(['boss']);
  });

  it('a rule switched off sends nothing', async () => {
    const { tx, notices } = fakeTx({
      flagRow: true,
      signal: stale,
      setting: { enabled: 0, threshold: 14, recipient: 'assignee' },
      owner: 'doer',
      memberships: PEOPLE,
    });
    await workSignalRaisedConsumer(event, tx, noEffects);
    expect(notices).toEqual([]);
  });

  it('the business_briefing flag off (the default) sends nothing and reads no signal', async () => {
    const { tx, notices, sql } = fakeTx({ signal: stale, owner: 'doer', memberships: PEOPLE });
    await workSignalRaisedConsumer(event, tx, noEffects);
    expect(notices).toEqual([]);
    expect(sql.some((text) => /FROM work_signals/.test(text))).toBe(false);
  });

  it('a money rule tells finance.view holders only — never a member without finance access', async () => {
    const { tx, notices } = fakeTx({
      flagRow: true,
      signal: {
        rule_key: 'approved_time_not_invoiced',
        subject_type: 'project',
        subject_id: 'p1',
        project_id: 'p1',
      },
      memberships: PEOPLE,
    });
    await workSignalRaisedConsumer(event, tx, noEffects);
    expect(notices).toEqual(['owner', 'lead']);
    expect(notices).not.toContain('doer');
  });
});

describe('flag gate', () => {
  it('business_briefing is off unless something turns it on', async () => {
    expect(
      await organizationsWithFlagOn(fakeTx({ memberships: [] }).tx, BUSINESS_BRIEFING_FLAG, 10, {}),
    ).toEqual([]);
    expect(
      await organizationsWithFlagOn(
        fakeTx({ flagRow: true, memberships: [] }).tx,
        BUSINESS_BRIEFING_FLAG,
        10,
        {},
      ),
    ).toEqual([ORG]);
  });

  it('a server lock wins over the organization row', async () => {
    const { tx } = fakeTx({ flagRow: true, memberships: [] });
    const env = { TMANAGE_FLAG_LOCKS: 'business_briefing=off' };
    expect(await organizationsWithFlagOn(tx, BUSINESS_BRIEFING_FLAG, 10, env)).toEqual([]);
  });
});

describe('fileSignals', () => {
  const signal = {
    rule: 'stale_task' as const,
    subjectType: 'work_item' as const,
    subjectId: 'w1',
    projectId: 'p1',
    measure: 20,
    threshold: 14,
  };

  function recordingTx(insertResult: number) {
    const calls: { sql: string; params: readonly unknown[] }[] = [];
    const tx: WorkerTransaction = {
      async query<T>(sql: string, params: readonly unknown[] = []): Promise<T> {
        calls.push({ sql, params });
        return (
          /INSERT IGNORE INTO work_signals/.test(sql) ? { affectedRows: insertResult } : {}
        ) as T;
      },
    };
    return { tx, calls };
  }

  it('a notifying signal writes its row and one outbox event, both dated by the bound now', async () => {
    const { tx, calls } = recordingTx(1);
    expect(await fileSignals(tx, ORG, [{ ...signal, notify: true }], NOW)).toBe(1);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.params).toContain('2026-11-19');
    expect(calls[0]?.params.at(-1)).toBe(NOW);
    expect(calls[1]?.params).toContain(WORK_SIGNAL_RAISED_EVENT);
    expect(calls[1]?.params.slice(-2)).toEqual([NOW, NOW]);
    for (const call of calls) expect(call.sql).not.toMatch(/NOW\(|CURRENT_TIMESTAMP|CURDATE/i);
  });

  it('an off rule writes the row and no event; a same-day duplicate writes nothing more', async () => {
    const off = recordingTx(1);
    await fileSignals(off.tx, ORG, [{ ...signal, notify: false }], NOW);
    expect(off.calls).toHaveLength(1);
    const duplicate = recordingTx(0);
    expect(await fileSignals(duplicate.tx, ORG, [{ ...signal, notify: true }], NOW)).toBe(0);
    expect(duplicate.calls).toHaveLength(1);
  });
});

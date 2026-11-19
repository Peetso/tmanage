import { describe, expect, it } from 'vitest';
import {
  decideNudge,
  MAX_NUDGES_PER_RUN,
  nudgeDedupeKey,
  sweepGettingStartedNudges,
  type NudgeCandidate,
  type NudgeStep,
} from './getting-started-nudges.js';
import {
  candidateOf,
  createGettingStartedNudgeStore,
  readStored,
  type NudgeRow,
} from '../common/database/getting-started-nudge-store.js';
import type { WorkerDatabase, WorkerTransaction } from '../common/database/worker-database.js';

/** 55-24 — first-week nudges: one a day, next unfinished step, prefs and quiet hours honoured. */

const NOW = new Date('2026-11-08T12:00:00.000Z');

function candidate(over: Partial<NudgeCandidate> = {}): NudgeCandidate {
  return {
    organizationId: 'o1',
    membershipId: 'm1',
    userId: 'u1',
    joinedAt: new Date('2026-11-06T09:00:00.000Z'),
    inAppEnabled: true,
    quietHours: null,
    dismissed: false,
    done: new Set<NudgeStep>(['invite_teammate']),
    nudgesToday: 0,
    ...over,
  };
}

describe('decideNudge (55-24)', () => {
  it('names the next unfinished step with a per-day dedupe key', () => {
    expect(decideNudge(candidate(), NOW)).toEqual({
      send: true,
      step: 'create_project',
      dedupeKey: 'getting_started:m1:2026-11-08',
    });
    expect(nudgeDedupeKey('m1', new Date('2026-11-09T00:00:01Z'))).toBe(
      'getting_started:m1:2026-11-09',
    );
  });

  it('stays silent after the first week, when dismissed, in-app off, or all done', () => {
    const late = candidate({ joinedAt: new Date('2026-10-31T11:59:00.000Z') });
    expect(decideNudge(late, NOW)).toMatchObject({ send: false, reason: 'outside_first_week' });
    expect(decideNudge(candidate({ dismissed: true }), NOW)).toMatchObject({ send: false });
    expect(decideNudge(candidate({ inAppEnabled: false }), NOW)).toMatchObject({
      reason: 'in_app_off',
    });
    const all = new Set<NudgeStep>([
      'invite_teammate',
      'create_project',
      'add_client',
      'connect_storage',
      'set_working_hours',
      'try_ai_assistant',
    ]);
    expect(decideNudge(candidate({ done: all }), NOW)).toMatchObject({ reason: 'all_done' });
  });

  it('defers inside quiet hours', () => {
    const quiet = candidate({
      quietHours: {
        quietHoursStart: '11:00:00',
        quietHoursEnd: '13:00:00',
        quietHoursTimezone: 'UTC',
      },
    });
    expect(decideNudge(quiet, NOW)).toMatchObject({ send: false, reason: 'quiet_hours' });
  });

  it('sends at most once a day even when the sweep runs twice', async () => {
    const keys = new Set<string>();
    const store = {
      listCandidates: () => Promise.resolve([candidate()]),
      sendNudge: (_c: NudgeCandidate, _s: NudgeStep, key: string) => {
        const fresh = !keys.has(key);
        keys.add(key);
        return Promise.resolve(fresh);
      },
    };
    expect((await sweepGettingStartedNudges(store, NOW)).sent).toBe(1);
    expect((await sweepGettingStartedNudges(store, NOW)).sent).toBe(0);
  });

  it('reads stored marks and company signals from a row', () => {
    expect(readStored('{"marked":["add_client","bogus"],"dismissedAt":"2026-11-07"}')).toEqual({
      marked: ['add_client'],
      dismissed: true,
    });
    const c = candidateOf({
      membership_id: 'm1',
      organization_id: 'o1',
      user_id: 'u1',
      created_at: '2026-11-06T09:00:00.000Z',
      in_app_enabled: null,
      quiet_hours_start: null,
      quiet_hours_end: null,
      quiet_hours_timezone: null,
      gs_json: null,
      invite_teammate: 1,
      create_project: 0,
      add_client: 0,
      connect_storage: 1,
      set_working_hours: 0,
      try_ai_assistant: 0,
      nudges_today: '0',
    });
    expect(c.inAppEnabled).toBe(true);
    expect([...c.done]).toEqual(['invite_teammate', 'connect_storage']);
    expect(c.nudgesToday).toBe(0);
  });
});

/** A candidate row as the live SELECT returns it: first week, invite done, nothing sent today. */
const ROW: NudgeRow = {
  membership_id: 'm1',
  organization_id: 'o1',
  user_id: 'u1',
  created_at: '2026-11-06T09:00:00.000Z',
  in_app_enabled: 1,
  quiet_hours_start: null,
  quiet_hours_end: null,
  quiet_hours_timezone: null,
  gs_json: null,
  invite_teammate: 1,
  create_project: 0,
  add_client: 0,
  connect_storage: 0,
  set_working_hours: 0,
  try_ai_assistant: 0,
  nudges_today: 0,
};

/**
 * A database that behaves like live: `uq_notifications_dedupe` holds, so a second insert of the same
 * notice is refused with `ER_DUP_ENTRY` (1062). The candidate read always says "nothing sent
 * today", the view a second process has when it reads before the first one commits.
 */
function liveLikeDatabase(): { database: WorkerDatabase; rows: Map<string, string> } {
  const rows = new Map<string, string>(); // dedupe identity -> id
  const tx: WorkerTransaction = {
    query: <T>(sql: string, params: readonly unknown[] = []): Promise<T> => {
      if (sql.includes('FROM memberships m')) return Promise.resolve([ROW] as T);
      if (/^INSERT INTO notifications/.test(sql)) {
        const [id, org, user, , , , key] = params.map(String);
        const identity = `${String(org)}|${String(user)}|${String(key)}`;
        if (rows.has(identity)) {
          return Promise.reject(Object.assign(new Error('Duplicate entry'), { errno: 1062 }));
        }
        rows.set(identity, String(id));
        return Promise.resolve({ affectedRows: 1 } as T);
      }
      throw new Error(`unexpected statement: ${sql}`);
    },
  };
  const database = {
    transaction: <T>(work: (t: WorkerTransaction) => Promise<T>) => work(tx),
  } as unknown as WorkerDatabase;
  return { database, rows };
}

describe('nudge flood guard (2026-11-15)', () => {
  it('two consecutive sweeps against a live-like database send once', async () => {
    const { database, rows } = liveLikeDatabase();
    const store = createGettingStartedNudgeStore(database);
    expect((await sweepGettingStartedNudges(store, NOW)).sent).toBe(1);
    expect((await sweepGettingStartedNudges(store, new Date(NOW.getTime() + 60_000))).sent).toBe(0);
    expect(rows.size).toBe(1);
  });

  it('skips a member already nudged today, whatever the dedupe key says', () => {
    expect(decideNudge(candidate({ nudgesToday: 1 }), NOW)).toMatchObject({
      send: false,
      reason: 'daily_cap',
    });
  });

  it('stops one run at the global cap', async () => {
    const many = Array.from({ length: MAX_NUDGES_PER_RUN + 50 }, (_, i) =>
      candidate({ membershipId: `m${String(i)}` }),
    );
    const store = {
      listCandidates: () => Promise.resolve(many),
      sendNudge: () => Promise.resolve(true),
    };
    expect(await sweepGettingStartedNudges(store, NOW)).toEqual({
      candidates: many.length,
      sent: MAX_NUDGES_PER_RUN,
      capped: true,
    });
  });
});

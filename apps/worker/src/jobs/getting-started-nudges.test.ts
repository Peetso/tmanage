import { describe, expect, it } from 'vitest';
import {
  decideNudge,
  nudgeDedupeKey,
  sweepGettingStartedNudges,
  type NudgeCandidate,
  type NudgeStep,
} from './getting-started-nudges.js';
import { candidateOf, readStored } from '../common/database/getting-started-nudge-store.js';

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
    });
    expect(c.inAppEnabled).toBe(true);
    expect([...c.done]).toEqual(['invite_teammate', 'connect_storage']);
  });
});

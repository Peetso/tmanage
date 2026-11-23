import { describe, expect, it } from 'vitest';
import { autostopEntryFor, autostopHours, sweepForgottenTimers } from './timer-autostop.js';
import type { AutostopEntry, RunningTimer, TimerAutostopStore } from './timer-autostop.js';

/** 52-01 — the forgotten-timer auto-stop, over a fake store that deletes like the real one. */

const timer = (over: Partial<RunningTimer> = {}): RunningTimer => ({
  id: 'tm-1',
  organizationId: 'org-1',
  membershipId: 'mem-1',
  userId: 'u-1',
  workItemId: 'wi-1',
  projectId: 'p-1',
  note: null,
  billable: true,
  startedAt: new Date('2026-10-30T00:00:00Z'),
  policy: null,
  roundingMinutes: 15,
  ...over,
});

describe('timer auto-stop', () => {
  it('stops at the org limit, flags needs_review, and is idempotent on retry', async () => {
    const running = new Set(['tm-1', 'tm-2']);
    const filed: AutostopEntry[] = [];
    const store: TimerAutostopStore = {
      listCandidates: async () => [
        timer(),
        timer({ id: 'tm-2', policy: '{"time_autostop_hours":24}' }),
      ],
      autostop: async (t, entry) => {
        if (!running.delete(t.id)) return false;
        filed.push(entry);
        return true;
      },
    };
    const now = new Date('2026-10-30T13:00:00Z');
    expect(await sweepForgottenTimers(store, now)).toEqual({ stopped: 1, skipped: 1 });
    expect(filed).toEqual([
      expect.objectContaining({
        endedAt: new Date('2026-10-30T10:00:00Z'), // the 10 h default, not "now"
        minutes: 600,
        needsReview: true,
        source: 'timer',
        // 2026-11-23 time trust: a capped timer never silently counts.
        approvalState: 'pending',
        counted: false,
      }),
    ]);
    // A retry still lists the stopped timer (a stale read); the store's delete refuses it.
    expect(await sweepForgottenTimers(store, now)).toEqual({ stopped: 0, skipped: 2 });
    expect(filed).toHaveLength(1);
  });

  it("takes the owner's idle cap over the older policy document, and ignores a bad one", () => {
    const at = new Date('2026-10-31T00:00:00Z');
    const capped = autostopEntryFor(
      timer({ policy: '{"time_autostop_hours":24}', idleCapSetting: '6' }),
      at,
    );
    expect(capped?.autostopHours).toBe(6);
    expect(autostopHours('{"time_autostop_hours":24}', '99')).toBe(24);
    expect(autostopHours(null, 'x')).toBe(10);
    expect(autostopHours(null, '3')).toBe(10);
  });
});

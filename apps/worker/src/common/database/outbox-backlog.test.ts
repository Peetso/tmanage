import { describe, expect, it } from 'vitest';
import { computeBacklog } from './outbox-store.js';

/**
 * IMPORTANT-E: the backlog age must come from the event's own `occurred_at`, not from
 * `available_at`, which a retry pushes into the future. Before this, a chronically failing but
 * still-retried row backed its clock off on every attempt and reported an age near zero, so a
 * genuinely stuck queue looked healthy. The age math moved out of SQL into {@link computeBacklog}
 * precisely so it can be proven without a database; the server-side half is exercised by
 * `apps/api/test/plat-004-claim-attempts.db.test.ts`.
 */

const NOW = new Date('2026-09-19T12:00:00.000Z');
const secondsAgo = (n: number): Date => new Date(NOW.getTime() - n * 1000);
const inSeconds = (n: number): Date => new Date(NOW.getTime() + n * 1000);
const MAX_ATTEMPTS = 3;

describe('computeBacklog — the oldest pending age (IMPORTANT-E)', () => {
  it('measures a backed-off row from occurred_at, keeps parked rows out of the age, and counts both', () => {
    const backlog = computeBacklog(
      [
        // Stuck for two hours and retried, so its next attempt is 600s in the future: its age is
        // the two hours since it occurred, not the negative gap to available_at.
        { attempts: 2, occurredAt: secondsAgo(7200), availableAt: inSeconds(600) },
        { attempts: 0, occurredAt: secondsAgo(30), availableAt: secondsAgo(30) },
        // Parked: counted, but must not pin the age at "growing for ever" and drown the signal.
        { attempts: MAX_ATTEMPTS, occurredAt: secondsAgo(86_400), availableAt: secondsAgo(86_400) },
      ],
      NOW,
      MAX_ATTEMPTS,
    );

    expect(backlog).toEqual({ pending: 2, parked: 1, oldestPendingSeconds: 7200 });
  });

  it('floors a row whose occurred_at is itself in the future at zero, never negative', () => {
    const backlog = computeBacklog(
      [{ attempts: 0, occurredAt: inSeconds(600), availableAt: inSeconds(600) }],
      NOW,
      MAX_ATTEMPTS,
    );

    expect(backlog).toEqual({ pending: 1, parked: 0, oldestPendingSeconds: 0 });
  });

  it('reports a null age and zero counts for a drained queue, not a zero age', () => {
    expect(computeBacklog([], NOW, MAX_ATTEMPTS)).toEqual({
      pending: 0,
      parked: 0,
      oldestPendingSeconds: null,
    });
  });
});

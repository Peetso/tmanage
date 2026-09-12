import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  backlogIsStale,
  describeHealth,
  evaluateOutboxHealth,
  readHeartbeat,
  writeHeartbeat,
} from './health.js';
import type { OutboxHealthThresholds } from './health.js';

/**
 * CRITICAL-2 of the worker/outbox audit: **if the worker stopped draining right now, nothing
 * would say so.**
 *
 * > A healthy idle worker prints nothing. A dead worker prints nothing. The two are
 * > indistinguishable from the log. [...] There is no heartbeat table, no `last_drained_at`,
 * > no backlog-age metric, no health or readiness endpoint [...] Consequence: every failure
 * > mode above [...] presents identically as *nothing happening*.
 *
 * And the fix the report names as the highest-value change on the whole list:
 *
 * > it is one database query, exposed as a health check, that answers "what is the oldest
 * > thing waiting to be delivered?"
 *
 * What is under test here is the verdict and the heartbeat's durability — the query itself
 * is SQL and belongs to `apps/api/test/plat-004-claim-attempts.db.test.ts`. The clock is
 * injected, so a stale heartbeat costs no wall-clock time.
 */

const THRESHOLDS: OutboxHealthThresholds = {
  backlogMaxAgeSeconds: 900,
  heartbeatMaxAgeSeconds: 900,
};

const NOW = new Date('2026-09-12T12:00:00.000Z');
const secondsAgo = (seconds: number): Date => new Date(NOW.getTime() - seconds * 1000);

let directory: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'tmanage-heartbeat-'));
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('outbox health verdict', () => {
  it('is ok when the queue is drained and a batch finished recently', () => {
    const health = evaluateOutboxHealth({
      backlog: { pending: 0, parked: 0, oldestPendingSeconds: null },
      lastPollAt: secondsAgo(5),
      now: NOW,
      thresholds: THRESHOLDS,
    });

    expect(health.status).toBe('ok');
    expect(health.reasons).toEqual([]);
    expect(health.oldestPendingSeconds).toBeNull();
    expect(health.secondsSinceLastPoll).toBe(5);
  });

  it('is ok with a busy but fresh queue — a backlog is not by itself a fault', () => {
    const health = evaluateOutboxHealth({
      backlog: { pending: 400, parked: 0, oldestPendingSeconds: 30 },
      lastPollAt: secondsAgo(2),
      now: NOW,
      thresholds: THRESHOLDS,
    });

    expect(health.status).toBe('ok');
    expect(health.pending).toBe(400);
  });

  it('is degraded when the oldest pending event is older than the threshold', () => {
    // The audit's whole point: this is true whatever stopped the relay — a crash loop, a
    // killed process, an exhausted pool, a cron entry someone removed.
    const health = evaluateOutboxHealth({
      backlog: { pending: 3, parked: 0, oldestPendingSeconds: 901 },
      lastPollAt: secondsAgo(1),
      now: NOW,
      thresholds: THRESHOLDS,
    });

    expect(health.status).toBe('degraded');
    expect(health.reasons).toEqual(['backlog-age']);
  });

  it('is degraded when no batch has finished for longer than the threshold', () => {
    // The reading backlog age cannot give: a dead relay on a quiet weekend, with nothing
    // produced to be late. Drained and dead look identical until the heartbeat goes stale.
    const health = evaluateOutboxHealth({
      backlog: { pending: 0, parked: 0, oldestPendingSeconds: null },
      lastPollAt: secondsAgo(3600),
      now: NOW,
      thresholds: THRESHOLDS,
    });

    expect(health.status).toBe('degraded');
    expect(health.reasons).toEqual(['heartbeat-stale']);
    expect(health.secondsSinceLastPoll).toBe(3600);
  });

  it('names both reasons when both readings are bad', () => {
    const health = evaluateOutboxHealth({
      backlog: { pending: 12, parked: 2, oldestPendingSeconds: 86_400 },
      lastPollAt: null,
      now: NOW,
      thresholds: THRESHOLDS,
    });

    expect(health.reasons).toEqual(['backlog-age', 'heartbeat-missing']);
    expect(health.lastPollAt).toBeNull();
    expect(health.secondsSinceLastPoll).toBeNull();
  });

  it('does not fire on the threshold itself, only past it', () => {
    const atThreshold = evaluateOutboxHealth({
      backlog: { pending: 1, parked: 0, oldestPendingSeconds: 900 },
      lastPollAt: secondsAgo(900),
      now: NOW,
      thresholds: THRESHOLDS,
    });
    expect(atThreshold.status).toBe('ok');
  });

  it('reads a heartbeat from the future as age zero rather than as a negative', () => {
    const health = evaluateOutboxHealth({
      backlog: { pending: 0, parked: 0, oldestPendingSeconds: null },
      lastPollAt: new Date(NOW.getTime() + 60_000),
      now: NOW,
      thresholds: THRESHOLDS,
    });
    expect(health.secondsSinceLastPoll).toBe(0);
    expect(health.status).toBe('ok');
  });

  it('describes itself without an id, a payload or an address', () => {
    const line = describeHealth(
      evaluateOutboxHealth({
        backlog: { pending: 3, parked: 1, oldestPendingSeconds: 4000 },
        lastPollAt: secondsAgo(120),
        now: NOW,
        thresholds: THRESHOLDS,
      }),
    );
    expect(line).toContain('degraded');
    expect(line).toContain('backlog-age');
    expect(line).toContain('oldest pending 4000s');
    expect(line).toContain('last batch 120s ago');
  });
});

describe('the --once exit-code condition', () => {
  it('is false while nothing is waiting, however many parked rows there are', () => {
    expect(backlogIsStale({ pending: 0, parked: 9, oldestPendingSeconds: null }, 900)).toBe(false);
  });

  it('is false for a queue that is merely busy', () => {
    expect(backlogIsStale({ pending: 50, parked: 0, oldestPendingSeconds: 12 }, 900)).toBe(false);
  });

  it('is true once the oldest waiting event is past the threshold', () => {
    // `main.ts` turns this into `process.exitCode = 1`, which is what makes cron's own
    // failure reporting the alarm the audit found missing.
    expect(backlogIsStale({ pending: 1, parked: 0, oldestPendingSeconds: 901 }, 900)).toBe(true);
  });
});

describe('the heartbeat file', () => {
  it('round-trips the time a batch finished', async () => {
    const path = join(directory, 'beat.json');
    await writeHeartbeat(path, NOW);
    await expect(readHeartbeat(path)).resolves.toEqual(NOW);
  });

  it('creates the directory it was pointed at', async () => {
    const path = join(directory, 'nested', 'deeper', 'beat.json');
    await writeHeartbeat(path, NOW);
    await expect(readHeartbeat(path)).resolves.toEqual(NOW);
  });

  it('overwrites the previous beat rather than accumulating', async () => {
    const path = join(directory, 'overwrite.json');
    await writeHeartbeat(path, secondsAgo(600));
    await writeHeartbeat(path, NOW);
    await expect(readHeartbeat(path)).resolves.toEqual(NOW);
  });

  it('reads a missing file as no heartbeat, not as an error', async () => {
    await expect(readHeartbeat(join(directory, 'never-written.json'))).resolves.toBeNull();
  });

  it('reads an unparseable or foreign file as no heartbeat', async () => {
    const garbage = join(directory, 'garbage.json');
    await writeFile(garbage, 'not json at all', 'utf8');
    await expect(readHeartbeat(garbage)).resolves.toBeNull();

    const foreign = join(directory, 'foreign.json');
    await writeFile(foreign, JSON.stringify({ somethingElse: 1 }), 'utf8');
    await expect(readHeartbeat(foreign)).resolves.toBeNull();

    const nonsenseDate = join(directory, 'nonsense-date.json');
    await writeFile(nonsenseDate, JSON.stringify({ lastPollAt: 'yesterday-ish' }), 'utf8');
    await expect(readHeartbeat(nonsenseDate)).resolves.toBeNull();
  });

  it('turns an unreadable heartbeat into a degraded verdict, not a crash', async () => {
    const lastPollAt = await readHeartbeat(join(directory, 'absent.json'));
    const health = evaluateOutboxHealth({
      backlog: { pending: 0, parked: 0, oldestPendingSeconds: null },
      lastPollAt,
      now: NOW,
      thresholds: THRESHOLDS,
    });
    expect(health.status).toBe('degraded');
    expect(health.reasons).toEqual(['heartbeat-missing']);
  });
});

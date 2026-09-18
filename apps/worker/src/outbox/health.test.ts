import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  backlogIsStale,
  describeHealth,
  evaluateOutboxHealth,
  heartbeatTempPath,
  onceIsUnhealthy,
  readHeartbeat,
  readHeartbeatState,
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
      heartbeatConfigured: true,
      lastPollAt: secondsAgo(5),
      now: NOW,
      thresholds: THRESHOLDS,
    });

    expect(health.status).toBe('ok');
    expect(health.reasons).toEqual([]);
    expect(health.oldestPendingSeconds).toBeNull();
    expect(health.secondsSinceLastPoll).toBe(5);
  });

  it('is ok when no heartbeat file is configured and the queue is drained (CRITICAL-A)', () => {
    // A host with no writable path clears `OUTBOX_HEARTBEAT_FILE`, normalised to undefined.
    // Before this fix that reported `heartbeat-missing` and exited 1 on a healthy, fully drained
    // queue on every invocation, for ever — an alarm silenced in week one. Absence of a
    // *configured* heartbeat is not a fault; it narrows the readings to backlog age, exactly as
    // the runbook and env.ts already promised. (`.env.example` now ships a real path, so the
    // default deployment keeps both readings — this branch is the opt-out, not the default.)
    const health = evaluateOutboxHealth({
      backlog: { pending: 0, parked: 0, oldestPendingSeconds: null },
      heartbeatConfigured: false,
      lastPollAt: null,
      now: NOW,
      thresholds: THRESHOLDS,
    });

    expect(health.status).toBe('ok');
    expect(health.reasons).toEqual([]);
  });

  it('is ok with a busy but fresh queue — a backlog is not by itself a fault', () => {
    const health = evaluateOutboxHealth({
      backlog: { pending: 400, parked: 0, oldestPendingSeconds: 30 },
      heartbeatConfigured: true,
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
      heartbeatConfigured: true,
      lastPollAt: secondsAgo(1),
      now: NOW,
      thresholds: THRESHOLDS,
    });

    expect(health.status).toBe('degraded');
    expect(health.reasons).toEqual(['backlog-age']);
  });

  it('is degraded when a row has parked, even on an otherwise healthy relay (CRITICAL-C)', () => {
    // Parking is the *success* condition of claim-time counting, and it was invisible to every
    // signal the same slice added: `relay:status` said ok with a queue full of parked events.
    // A parked row is permanent, silent non-delivery — it must make the verdict degraded.
    const health = evaluateOutboxHealth({
      backlog: { pending: 0, parked: 3, oldestPendingSeconds: null },
      heartbeatConfigured: true,
      lastPollAt: secondsAgo(5),
      now: NOW,
      thresholds: THRESHOLDS,
    });

    expect(health.status).toBe('degraded');
    expect(health.reasons).toEqual(['parked']);
    expect(health.parked).toBe(3);
  });

  it('is degraded when no batch has finished for longer than the threshold', () => {
    // The reading backlog age cannot give: a dead relay on a quiet weekend, with nothing
    // produced to be late. Drained and dead look identical until the heartbeat goes stale.
    const health = evaluateOutboxHealth({
      backlog: { pending: 0, parked: 0, oldestPendingSeconds: null },
      heartbeatConfigured: true,
      lastPollAt: secondsAgo(3600),
      now: NOW,
      thresholds: THRESHOLDS,
    });

    expect(health.status).toBe('degraded');
    expect(health.reasons).toEqual(['heartbeat-stale']);
    expect(health.secondsSinceLastPoll).toBe(3600);
  });

  it('names every reason when all readings are bad', () => {
    const health = evaluateOutboxHealth({
      backlog: { pending: 12, parked: 2, oldestPendingSeconds: 86_400 },
      heartbeatConfigured: true,
      lastPollAt: null,
      now: NOW,
      thresholds: THRESHOLDS,
    });

    expect(health.reasons).toEqual(['backlog-age', 'parked', 'heartbeat-missing']);
    expect(health.lastPollAt).toBeNull();
    expect(health.secondsSinceLastPoll).toBeNull();
  });

  it('does not fire on the threshold itself, only past it', () => {
    const atThreshold = evaluateOutboxHealth({
      backlog: { pending: 1, parked: 0, oldestPendingSeconds: 900 },
      heartbeatConfigured: true,
      lastPollAt: secondsAgo(900),
      now: NOW,
      thresholds: THRESHOLDS,
    });
    expect(atThreshold.status).toBe('ok');
  });

  it('reads a heartbeat from the future as age zero rather than as a negative', () => {
    const health = evaluateOutboxHealth({
      backlog: { pending: 0, parked: 0, oldestPendingSeconds: null },
      heartbeatConfigured: true,
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
        heartbeatConfigured: true,
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
  it('is false while nothing is waiting and nothing has parked', () => {
    expect(onceIsUnhealthy({ pending: 0, parked: 0, oldestPendingSeconds: null }, 900)).toBe(false);
  });

  it('is false for a queue that is merely busy', () => {
    expect(onceIsUnhealthy({ pending: 50, parked: 0, oldestPendingSeconds: 12 }, 900)).toBe(false);
  });

  it('is true once the oldest waiting event is past the threshold', () => {
    // `main.ts` turns this into `process.exitCode = 1`, which is what makes cron's own
    // failure reporting the alarm the audit found missing.
    expect(onceIsUnhealthy({ pending: 1, parked: 0, oldestPendingSeconds: 901 }, 900)).toBe(true);
  });

  it('is true whenever a row has parked, even with a drained pending set (CRITICAL-C)', () => {
    // A cron `relay:once` exiting 0 on a queue full of parked events is exactly the silence
    // CRITICAL-C describes. Parking must make cron's own alarm fire.
    expect(onceIsUnhealthy({ pending: 0, parked: 4, oldestPendingSeconds: null }, 900)).toBe(true);
  });

  it('the age-only reading still ignores parked rows — that is backlogIsStale, unchanged', () => {
    expect(backlogIsStale({ pending: 0, parked: 9, oldestPendingSeconds: null }, 900)).toBe(false);
  });
});

describe('readHeartbeatState — the CRITICAL-A wiring decision', () => {
  it('reports not-configured for an undefined path, without touching the disk', async () => {
    await expect(readHeartbeatState(undefined)).resolves.toEqual({
      configured: false,
      lastPollAt: null,
    });
  });

  it('reports configured with the recorded time for a written file', async () => {
    const path = join(directory, 'state-present.json');
    await writeHeartbeat(path, NOW);
    await expect(readHeartbeatState(path)).resolves.toEqual({ configured: true, lastPollAt: NOW });
  });

  it('reports configured-but-missing for a path that was set but never written', async () => {
    await expect(readHeartbeatState(join(directory, 'state-absent.json'))).resolves.toEqual({
      configured: true,
      lastPollAt: null,
    });
  });

  it('is configured by the shipped .env.example, so the default deployment keeps both readings', async () => {
    // CRITICAL-A was fixed the right way round — an unconfigured heartbeat is honest, not a
    // fault — but the repository then shipped `OUTBOX_HEARTBEAT_FILE` empty, so the reading that
    // separates "drained and idle" from "dead with an empty queue" was absent from the default
    // deployment: a relay that died on Friday with a drained queue reported ok and exited 0 all
    // weekend. The fix is the shipped value, not a change to the verdict — making "unconfigured"
    // degraded would delete the `heartbeatConfigured` distinction CRITICAL-A turns on and page
    // every host that legitimately keeps none.
    const example = fileURLToPath(new URL('../../../../.env.example', import.meta.url));
    const shipped = /^OUTBOX_HEARTBEAT_FILE=(.*)$/m.exec(await readFile(example, 'utf8'));
    const path = shipped?.[1]?.trim() ?? '';

    expect(path).not.toBe('');
    await expect(readHeartbeatState(path)).resolves.toMatchObject({ configured: true });

    // Which is what makes a dead relay with a drained queue reportable at all.
    const health = evaluateOutboxHealth({
      backlog: { pending: 0, parked: 0, oldestPendingSeconds: null },
      heartbeatConfigured: true,
      lastPollAt: null,
      now: NOW,
      thresholds: THRESHOLDS,
    });
    expect(health.status).toBe('degraded');
    expect(health.reasons).toEqual(['heartbeat-missing']);
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

  it('gives each write a unique, per-process temp path (IMPORTANT-F)', () => {
    // A fixed `${path}.tmp` lets two concurrent writers — the loop's fire-and-forget beat, a
    // `relay:once` beside it, a second relay — interleave into one temp file and rename garbage
    // into place, which reads back as a false `heartbeat-missing`. Each write needs its own.
    const a = heartbeatTempPath('/var/beat.json');
    const b = heartbeatTempPath('/var/beat.json');
    expect(a).not.toBe(b);
    expect(a).toContain(String(process.pid));
    expect(a.endsWith('.tmp')).toBe(true);
  });

  it('survives concurrent writes to one path, reading back one whole beat', async () => {
    const path = join(directory, 'concurrent.json');
    const first = secondsAgo(10);
    await Promise.all([writeHeartbeat(path, first), writeHeartbeat(path, NOW)]);
    // Whichever landed last, it is a *complete* heartbeat, never a half-written one read as null.
    const read = await readHeartbeat(path);
    expect(read).not.toBeNull();
    expect([first.getTime(), NOW.getTime()]).toContain(read?.getTime());
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

  it('turns a configured-but-unreadable heartbeat into a degraded verdict, not a crash', async () => {
    const { configured, lastPollAt } = await readHeartbeatState(join(directory, 'absent.json'));
    const health = evaluateOutboxHealth({
      backlog: { pending: 0, parked: 0, oldestPendingSeconds: null },
      heartbeatConfigured: configured,
      lastPollAt,
      now: NOW,
      thresholds: THRESHOLDS,
    });
    expect(health.status).toBe('degraded');
    expect(health.reasons).toEqual(['heartbeat-missing']);
  });
});

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { OutboxBacklog } from '../common/database/outbox-store.js';

/**
 * Is the relay draining? — the answer CRITICAL-2 of the worker/outbox audit found nowhere.
 *
 * ## What was missing
 *
 * Every signal the worker had was conditional on something happening: a log line only when a
 * batch claimed something, an error only while the process was alive to print it, and
 * `--once` exiting 0 whatever the queue looked like. A healthy idle worker and a worker that
 * died on Friday night produced byte-identical output — nothing — so the first person to
 * notice was a client asking why they never got an email.
 *
 * ## The two readings
 *
 * - **Backlog age** — {@link OutboxBacklog.oldestPendingSeconds}, from the database. It is
 *   the audit's "single highest-value change": near zero while the relay drains, growing
 *   without bound the moment it stops, and it does not care *why* it stopped. It works
 *   identically for the polling loop and for cron-driven `--once` batches, which is what
 *   makes it the right measurement for a deployment that may be either.
 * - **Heartbeat** — when a batch last completed, from {@link readHeartbeat}. Backlog age
 *   alone cannot tell "drained and idle" from "dead with an empty queue"; the heartbeat can,
 *   and it is the reading that goes stale on a host where nothing is being produced either.
 *
 * Neither is a substitute for the other, so {@link evaluateOutboxHealth} reports both and
 * names every reason it is unhappy rather than collapsing them into one bit.
 *
 * ## Why a file and a CLI rather than an HTTP endpoint
 *
 * The deployment target runs the relay as cron-driven batches, one proxied Node app per
 * domain — there is no spare port for the worker to answer on, and a health endpoint that
 * only exists in loop mode would be absent from exactly the shape that needs it most. A
 * heartbeat file plus `relay:status`' exit code is checkable by cron itself, by a shell
 * one-liner, and by any uptime monitor that can run a command. Nothing here forecloses an
 * endpoint later: `evaluateOutboxHealth` is a pure function over the two readings, and a
 * route would serve the same object.
 */

export interface OutboxHealthThresholds {
  /** Above this, the oldest waiting event says the relay is not draining. */
  readonly backlogMaxAgeSeconds: number;
  /** Above this, the last completed batch is too long ago for the relay to be running. */
  readonly heartbeatMaxAgeSeconds: number;
}

/** Why health is not `ok`. Stable strings — a monitor may match on them. */
export type OutboxHealthReason = 'backlog-age' | 'heartbeat-missing' | 'heartbeat-stale';

export interface OutboxHealth {
  readonly status: 'ok' | 'degraded';
  /** Empty exactly when `status` is `ok`. */
  readonly reasons: readonly OutboxHealthReason[];
  readonly pending: number;
  readonly parked: number;
  /** `null` means nothing is pending — drained, not unmeasured. */
  readonly oldestPendingSeconds: number | null;
  /** ISO-8601, or `null` when no batch has ever recorded one here. */
  readonly lastPollAt: string | null;
  readonly secondsSinceLastPoll: number | null;
  readonly thresholds: OutboxHealthThresholds;
}

export interface OutboxHealthInput {
  readonly backlog: OutboxBacklog;
  readonly lastPollAt: Date | null;
  readonly now: Date;
  readonly thresholds: OutboxHealthThresholds;
}

/**
 * Pure: two readings and two thresholds in, a verdict out. Injected `now` rather than a
 * captured clock, so the unit suite can age a heartbeat without waiting for one.
 */
export function evaluateOutboxHealth(input: OutboxHealthInput): OutboxHealth {
  const reasons: OutboxHealthReason[] = [];

  const oldest = input.backlog.oldestPendingSeconds;
  if (oldest !== null && oldest > input.thresholds.backlogMaxAgeSeconds) {
    reasons.push('backlog-age');
  }

  let secondsSinceLastPoll: number | null = null;
  if (input.lastPollAt === null) {
    reasons.push('heartbeat-missing');
  } else {
    // Floored at 0: a heartbeat from the near future is a clock skew, not negative age.
    secondsSinceLastPoll = Math.max(
      0,
      Math.floor((input.now.getTime() - input.lastPollAt.getTime()) / 1000),
    );
    if (secondsSinceLastPoll > input.thresholds.heartbeatMaxAgeSeconds) {
      reasons.push('heartbeat-stale');
    }
  }

  return {
    status: reasons.length === 0 ? 'ok' : 'degraded',
    reasons,
    pending: input.backlog.pending,
    parked: input.backlog.parked,
    oldestPendingSeconds: oldest,
    lastPollAt: input.lastPollAt === null ? null : input.lastPollAt.toISOString(),
    secondsSinceLastPoll,
    thresholds: input.thresholds,
  };
}

/** `true` when the backlog alone is past its threshold — the `--once` exit-code condition. */
export function backlogIsStale(backlog: OutboxBacklog, maxAgeSeconds: number): boolean {
  const oldest = backlog.oldestPendingSeconds;
  return oldest !== null && oldest > maxAgeSeconds;
}

interface HeartbeatFile {
  readonly lastPollAt: string;
}

/**
 * Record that a batch completed.
 *
 * Written through a temporary file and renamed, because the reader is a separate process
 * (`--status`, a monitor, a shell) and a half-written heartbeat read as a missing one would
 * page somebody at four in the morning for a rename that had not landed yet.
 *
 * It does reject on a disk that refuses the write, and every caller in `main.ts` logs that
 * and carries on: a relay that cannot record a heartbeat must still deliver. The reading
 * then goes stale on its own, which is the honest verdict — a worker whose disk refuses
 * writes is not healthy — and it is the monitor's job to say so, not the relay's to stop.
 */
export async function writeHeartbeat(path: string, at: Date): Promise<void> {
  const body: HeartbeatFile = { lastPollAt: at.toISOString() };
  const temporary = `${path}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(temporary, `${JSON.stringify(body)}\n`, 'utf8');
  await rename(temporary, path);
}

/**
 * The last recorded batch, or `null` — which covers "never ran here", "the file was removed",
 * and "the file is not a heartbeat". All three mean the same thing to a monitor and none of
 * them is worth a distinct failure mode: no readable heartbeat is a missing heartbeat.
 */
export async function readHeartbeat(path: string): Promise<Date | null> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') return null;
    const value = (parsed as Record<string, unknown>)['lastPollAt'];
    if (typeof value !== 'string') return null;
    const at = new Date(value);
    return Number.isNaN(at.getTime()) ? null : at;
  } catch {
    return null;
  }
}

/** One line for the operator's log — no ids, no payloads, nothing a person typed. */
export function describeHealth(health: OutboxHealth): string {
  const age =
    health.oldestPendingSeconds === null ? 'none' : `${String(health.oldestPendingSeconds)}s`;
  const since =
    health.secondsSinceLastPoll === null ? 'never' : `${String(health.secondsSinceLastPoll)}s ago`;
  const why = health.reasons.length > 0 ? ` (${health.reasons.join(', ')})` : '';
  return (
    `${health.status}${why}: pending ${String(health.pending)}, ` +
    `parked ${String(health.parked)}, oldest pending ${age}, last batch ${since}`
  );
}

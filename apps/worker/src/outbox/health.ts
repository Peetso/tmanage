import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
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
export type OutboxHealthReason = 'backlog-age' | 'parked' | 'heartbeat-missing' | 'heartbeat-stale';

/**
 * The same three numbers as the totals, per queue — the split a monitor could otherwise only
 * find on stderr.
 *
 * `pending` / `parked` / `oldestPendingSeconds` at the top level are the **sum** over every
 * queue (see {@link mergeBacklogs}), which is the right default for the one question an
 * operator asks the process. But a summed `parked: 1` does not say *which table is stuck*, and
 * the answer decides what the operator does next: `outbox_events` is a client email, and
 * `credential_change_notices` is a security receipt nobody received. So the split is reported
 * beside the totals rather than instead of them, and the existing keys keep both their names
 * and their meaning-as-totals.
 */
export interface OutboxHealthQueues {
  /** `outbox_events` — the client-facing relay. */
  readonly outbox: OutboxBacklog;
  /** `credential_change_notices` — the security receipts (x31). */
  readonly notices: OutboxBacklog;
}

export interface OutboxHealth {
  readonly status: 'ok' | 'degraded';
  /** Empty exactly when `status` is `ok`. */
  readonly reasons: readonly OutboxHealthReason[];
  readonly pending: number;
  readonly parked: number;
  /** `null` means nothing is pending — drained, not unmeasured. */
  readonly oldestPendingSeconds: number | null;
  /**
   * The per-queue split of the three numbers above. Absent only when the caller measured a
   * single backlog and so has nothing to split — the CLI always supplies it.
   */
  readonly queues?: OutboxHealthQueues;
  /** ISO-8601, or `null` when no batch has ever recorded one here. */
  readonly lastPollAt: string | null;
  readonly secondsSinceLastPoll: number | null;
  readonly thresholds: OutboxHealthThresholds;
}

export interface OutboxHealthInput {
  /** The verdict is taken over this — the sum, when there is more than one queue. */
  readonly backlog: OutboxBacklog;
  /**
   * The queues {@link backlog} was merged from, reported verbatim beside the totals. Omit it
   * when there is only one backlog to report; passing it changes no verdict.
   */
  readonly queues?: OutboxHealthQueues;
  /**
   * Whether a heartbeat file is configured at all. When `false`, a `null` {@link lastPollAt}
   * is *not* a fault — it is a host that keeps no heartbeat, a supported shape (see
   * `OUTBOX_HEARTBEAT_FILE`). When `true`, a `null` reading means the beat is configured but
   * missing, which is `heartbeat-missing`. Conflating the two is CRITICAL-A: it made the
   * shipped empty-default report `degraded` on a healthy drained queue, always.
   */
  readonly heartbeatConfigured: boolean;
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

  // CRITICAL-C: a parked row is permanent, silent non-delivery until an operator resets it.
  // Parking is the *success* condition of the claim-time counting this slice added, so it
  // must be a verdict of its own — not merely a number beside an `ok`. Any parked row is a
  // page; the count is reported for triage, the threshold is zero.
  if (input.backlog.parked > 0) {
    reasons.push('parked');
  }

  let secondsSinceLastPoll: number | null = null;
  if (input.lastPollAt === null) {
    // CRITICAL-A: absence is only a fault when a heartbeat was actually configured. A host
    // with no writable path keeps none, and that is honest, not degraded — so `heartbeat-missing`
    // is pushed only when a path was configured and its beat could not be read.
    if (input.heartbeatConfigured) {
      reasons.push('heartbeat-missing');
    }
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
    // Additive: the key is absent rather than `null` when there is nothing to split, so no
    // monitor parsing the shipped keys sees a change it has to handle.
    ...(input.queues === undefined ? {} : { queues: input.queues }),
    lastPollAt: input.lastPollAt === null ? null : input.lastPollAt.toISOString(),
    secondsSinceLastPoll,
    thresholds: input.thresholds,
  };
}

/**
 * Two queues, one verdict — x31.
 *
 * The relay drains `outbox_events` and `credential_change_notices`, and an operator asks one
 * question of the process, not one per table: is anything undelivered, and for how long. So
 * `--status` and `--once` evaluate health over the *sum* — pending and parked added, the age
 * taken from whichever queue has waited longest — and the JSON line keeps the shape a monitor
 * already parses. A parked notice therefore raises the same page and the same exit code as a
 * parked event, which is the whole of "visible to health".
 *
 * `null` survives only when **every** queue is drained: one pending row anywhere is an age.
 */
export function mergeBacklogs(...backlogs: readonly OutboxBacklog[]): OutboxBacklog {
  const ages = backlogs
    .map((backlog) => backlog.oldestPendingSeconds)
    .filter((age): age is number => age !== null);
  return {
    pending: backlogs.reduce((total, backlog) => total + backlog.pending, 0),
    parked: backlogs.reduce((total, backlog) => total + backlog.parked, 0),
    oldestPendingSeconds: ages.length === 0 ? null : Math.max(...ages),
  };
}

/** `true` when the backlog alone is past its threshold — the loop's `not draining` condition. */
export function backlogIsStale(backlog: OutboxBacklog, maxAgeSeconds: number): boolean {
  const oldest = backlog.oldestPendingSeconds;
  return oldest !== null && oldest > maxAgeSeconds;
}

/**
 * The `--once` process exit-code condition: the backlog is past its age threshold, **or** at
 * least one event has parked (CRITICAL-C).
 *
 * A merely-failed event — retry pending — is deliberately not included: the retry is the
 * design and a page per transient failure is a page nobody reads. A *parked* event is
 * different: it is never claimed again without an operator, and cron's exit-code alarm is the
 * only place a batch-driven deployment can hear about it, since `--once` has no live process
 * to log to afterwards.
 */
export function onceIsUnhealthy(backlog: OutboxBacklog, maxAgeSeconds: number): boolean {
  return backlogIsStale(backlog, maxAgeSeconds) || backlog.parked > 0;
}

/**
 * Resolve what to feed {@link evaluateOutboxHealth} for the heartbeat, keeping "no file
 * configured" distinct from "configured but unreadable" — the distinction CRITICAL-A turned on.
 *
 * `undefined` path → not configured, and its absence is not a fault. A configured path →
 * `configured: true`, and {@link readHeartbeat} decides whether the beat is there.
 */
export async function readHeartbeatState(
  path: string | undefined,
): Promise<{ configured: boolean; lastPollAt: Date | null }> {
  if (path === undefined) return { configured: false, lastPollAt: null };
  return { configured: true, lastPollAt: await readHeartbeat(path) };
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
  const temporary = heartbeatTempPath(path);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(temporary, `${JSON.stringify(body)}\n`, 'utf8');
  try {
    await renameWithRetry(temporary, path);
  } catch (error) {
    // The rename could not land. Leave no orphan scratch file behind — every write uses its
    // own name (IMPORTANT-F), so an abandoned temp is pure litter — then surface the failure
    // to the caller, which logs and swallows it: a relay that cannot beat still delivers, and
    // the reading goes stale on its own.
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

/**
 * `rename` the beat into place, retrying a transient Windows race.
 *
 * Each writer renames its own unique temp file onto the one shared destination. On POSIX that
 * overwrite is atomic and never contends; on Windows two renames landing on the same existing
 * target at once raise a transient `EPERM`/`EACCES` while the other rename holds the target
 * briefly. It is not a real permission fault — a short bounded retry lets the loser land once
 * the winner's rename has completed. Anything else, or an exhausted budget, is rethrown.
 */
async function renameWithRetry(from: string, to: string, attempts = 5): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      const transient = code === 'EPERM' || code === 'EACCES';
      if (!transient || attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5 * attempt));
    }
  }
}

/**
 * The scratch path a single {@link writeHeartbeat} renames from — unique per process **and**
 * per call (IMPORTANT-F).
 *
 * A fixed `${path}.tmp` is safe for the reader (rename is atomic) but not for two concurrent
 * *writers* sharing it: the loop fires `beat` and-forget, `relay:once` and `relay:status` run
 * beside a live loop, and two relays are unenforced — any two writing at once would interleave
 * their bytes into one temp file and rename garbage into place, which `readHeartbeat` then
 * reads as `null` and the verdict as a false `heartbeat-missing`. A pid-and-UUID suffix gives
 * every write its own scratch file, so the only shared operation is the atomic rename.
 */
export function heartbeatTempPath(path: string): string {
  return `${path}.${String(process.pid)}.${randomUUID()}.tmp`;
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

// C10 — operator alerts for the in-process worker's jobs.
//
// The relay batch either throws (the database went away, a bug) or returns a report whose
// `failed` / `parked` say some event could not be delivered. Either is a job failure the operator
// should hear about, through the same notifier the API uses for a 5xx (`ALERT_EMAILS`, at most
// once per 15 minutes per kind — see apps/api/src/common/observability/alerts.ts). Only counts and
// an error class name are sent: an event's payload and a driver error's message never are.
//
// A healthy batch also records the worker heartbeat (`OUTBOX_HEARTBEAT_FILE`), so
// `GET /healthz/deep` can tell a running in-process relay from a stopped one.

/**
 * Report one relay batch.
 *
 * @param {{ notify(kind: string, facts?: object): Promise<string> } | null | undefined} alerts
 * @param {string} queue  a short stable name, e.g. `outbox` or `notices`
 * @param {{ report?: { failed?: number, parked?: readonly unknown[] }, error?: unknown }} outcome
 * @returns {Promise<string[]>} the kinds raised, for the unit test
 */
export async function reportJobOutcome(alerts, queue, outcome) {
  const raised = [];
  if (!alerts) return raised;
  if (outcome.error !== undefined) {
    const errorName =
      outcome.error instanceof Error ? outcome.error.constructor.name : typeof outcome.error;
    raised.push(`job_failed:${queue}`);
    await alerts.notify(`job_failed:${queue}`, { errorName }).catch(() => undefined);
    return raised;
  }
  const failed = outcome.report?.failed ?? 0;
  const parked = outcome.report?.parked?.length ?? 0;
  if (failed > 0) {
    raised.push(`job_failed:${queue}`);
    await alerts
      .notify(`job_failed:${queue}`, { detail: `${String(failed)} event(s) failed in one batch` })
      .catch(() => undefined);
  }
  if (parked > 0) {
    raised.push(`job_parked:${queue}`);
    await alerts
      .notify(`job_parked:${queue}`, {
        detail: `${String(parked)} event(s) gave up after the last retry and are parked`,
      })
      .catch(() => undefined);
  }
  return raised;
}

/**
 * Record a completed batch for the deep health check. A relay that cannot write its heartbeat
 * still delivers, so a failure here is swallowed (the deep check will then say `fail`).
 *
 * @param {((path: string, at: Date) => Promise<void>) | undefined} writeHeartbeat
 * @param {string | undefined} path
 */
export async function beat(writeHeartbeat, path) {
  if (!writeHeartbeat || !path) return;
  try {
    await writeHeartbeat(path, new Date());
  } catch {
    // see above
  }
}

/** How often the watchdog reads the heartbeat (51-07). */
export const WATCHDOG_INTERVAL_MS = 60_000;

/**
 * 51-07 — mail the operator when the worker heartbeat goes stale, and once when it recovers.
 *
 * The relay cannot report its own death: a batch wedged on a hung query never reaches the
 * `catch`, and an empty queue raises nothing. So a separate timer reads the same file
 * `GET /healthz/deep` reads and raises `worker_stale:relay` when it is older than
 * `OUTBOX_HEARTBEAT_MAX_AGE_SECONDS`. De-dup: one mail per stale spell (the notifier also caps a
 * kind at one per 15 minutes), one `worker_recovered:relay` when a fresh beat lands again.
 *
 * Shared hosting suspends an idle app; on wake every timer fires at once and the file is as old
 * as the nap. A check that comes more than two intervals after the previous one is that wake,
 * not an outage, so it is skipped (the relay's own tick refreshes the file first).
 *
 * @param {{
 *   alerts: { notify(kind: string, facts?: object): Promise<string> } | null | undefined,
 *   readHeartbeat: (path: string) => Promise<Date | null>,
 *   path: string | undefined,
 *   maxAgeSeconds: number,
 *   intervalMs?: number,
 *   now?: () => number,
 * }} options
 * @returns {{ check(): Promise<'off' | 'ok' | 'stale' | 'woke'> }}
 */
export function createHeartbeatWatchdog(options) {
  const intervalMs = options.intervalMs ?? WATCHDOG_INTERVAL_MS;
  const now = options.now ?? (() => Date.now());
  let lastCheckAt = null;
  let stale = false;
  return {
    async check() {
      const { alerts, path } = options;
      if (!alerts || !path) return 'off';
      const at = now();
      const woke = lastCheckAt !== null && at - lastCheckAt > 2 * intervalMs;
      lastCheckAt = at;
      if (woke) return 'woke';
      const last = await options.readHeartbeat(path).catch(() => null);
      const ageSeconds = last === null ? Infinity : (at - last.getTime()) / 1_000;
      if (ageSeconds > options.maxAgeSeconds) {
        if (!stale) {
          stale = true;
          const detail =
            last === null
              ? 'no worker heartbeat could be read'
              : `last completed batch ${String(Math.round(ageSeconds))} s ago`;
          await alerts.notify('worker_stale:relay', { detail }).catch(() => undefined);
        }
        return 'stale';
      }
      if (stale) {
        stale = false;
        await alerts
          .notify('worker_recovered:relay', { detail: 'background jobs are running again' })
          .catch(() => undefined);
      }
      return 'ok';
    },
  };
}

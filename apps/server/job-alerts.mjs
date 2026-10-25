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

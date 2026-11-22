/**
 * SEC-ALERTS — the `alerts` reading of `GET /healthz/deep`: can a security signal reach a person?
 *
 * SECURITY-INCIDENT-2026-11-21: `ALERT_EMAILS` was unset on live, so every platform signal was
 * stored as `notify_status = none`, and later SMTP refused the login for two days, so the pending
 * rows piled up unseen. Both were silent. This check makes them visible:
 *
 * - `not_configured` — `ALERT_EMAILS` is empty: platform signals are never mailed;
 * - `degraded` — configured, but a pending signal has waited longer than
 *   {@link ALERT_STUCK_MINUTES} (the digest window plus two detector ticks): the last send
 *   failed, or nothing is sending. A failed send leaves its rows `pending` and the detector retries
 *   every pass, so a pending row's age **is** the record of the failed digest; no second state is
 *   kept for it. Also `degraded` when a row was marked `none` in the last hour while the list
 *   is set (nobody was mailed: the worker had no mailer). An hour, by `notified_at`, so rows marked
 *   before the list was set stop counting soon after the fix;
 * - `ok` — configured, and nothing is stuck.
 *
 * Reported only, never a reason for 503 (the `backups` convention): a stuck alert is an operator
 * problem, not an outage of the app. States only in the public body; no counts, no addresses.
 * Unreadable table: `ok` is never claimed; the reading is `degraded`. The read is
 * `alerts-health.repository.ts`.
 */

export type AlertsCheckState = 'ok' | 'degraded' | 'not_configured';

/** 15-minute digest window + 2 × the 2-minute detector tick + slack. */
export const ALERT_STUCK_MINUTES = 25;
export const RECENT_NONE_MS = 3_600_000;

export interface AlertsReading {
  /** `first_seen` of the oldest `pending` signal, or null. */
  readonly oldestPending: Date | null;
  /** A row marked `none` (nobody mailed) within {@link RECENT_NONE_MS}. */
  readonly recentNone: boolean;
}

export function evaluateAlertsHealth(
  configured: boolean,
  reading: AlertsReading | null,
  now: Date,
): AlertsCheckState {
  if (!configured) return 'not_configured';
  if (reading === null) return 'degraded';
  if (reading.recentNone) return 'degraded';
  if (
    reading.oldestPending !== null &&
    now.getTime() - reading.oldestPending.getTime() > ALERT_STUCK_MINUTES * 60_000
  ) {
    return 'degraded';
  }
  return 'ok';
}

/**
 * 51-09 / 56-29. The `backups` reading of `GET /healthz/deep`, from `platform_backup_runs` (0253),
 * which `scripts/ops/backup.mjs` fills on every cron run.
 *
 * - `ok` — the newest successful dump finished within the window (26 h daily; 7 h once the
 *   6-hourly job is on), and, when that dump asked for an off-site copy, an off-site copy was
 *   uploaded within the same window;
 * - `stale` — a dump or a requested off-site copy is older than the window, or the newest run
 *   failed its off-site upload;
 * - `not_configured` — no successful dump was ever recorded (cron not set up yet) or the table
 *   cannot be read. Keyless host-only mode (off-site `skipped`) is `ok`, not stale: the trust
 *   centre then states host-only backups (56-29 default).
 *
 * Reported, never a reason for 503 by itself: a late backup is an alert (56-23), not an outage.
 */

export type BackupCheckState = 'ok' | 'stale' | 'not_configured';

export interface BackupRunReading {
  readonly finishedAt: Date;
  readonly offsiteStatus: string;
  readonly offsiteAt: Date | null;
}

export const BACKUP_WINDOW_DAILY_HOURS = 26;
export const BACKUP_WINDOW_SIXHOURLY_HOURS = 7;

/** `runs`: the successful non-drill runs, newest first. */
export function evaluateBackupHealth(
  runs: readonly BackupRunReading[],
  now: Date,
  options: { readonly sixHourly?: boolean } = {},
): BackupCheckState {
  const newest = runs[0];
  if (newest === undefined) return 'not_configured';
  const hours =
    options.sixHourly === true ? BACKUP_WINDOW_SIXHOURLY_HOURS : BACKUP_WINDOW_DAILY_HOURS;
  const fresh = (at: Date | null): boolean =>
    at !== null && now.getTime() - at.getTime() <= hours * 3_600_000;
  if (!fresh(newest.finishedAt)) return 'stale';
  if (newest.offsiteStatus === 'skipped' || newest.offsiteStatus === 'not_requested') return 'ok';
  // Off-site requested: the newest uploaded copy (in any run) must be inside the daily window.
  const lastOffsite = runs.find((r) => r.offsiteStatus === 'uploaded')?.offsiteAt ?? null;
  const offsiteFresh =
    lastOffsite !== null &&
    now.getTime() - lastOffsite.getTime() <= BACKUP_WINDOW_DAILY_HOURS * 3_600_000;
  return offsiteFresh ? 'ok' : 'stale';
}

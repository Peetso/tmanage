/**
 * 51-09 / 56-29 / OFFSITE-BACKUP. The `backups` reading of `GET /healthz/deep`, from
 * `platform_backup_runs` (0253), which the in-app `offsite-backup` job
 * (`apps/worker/src/backup/offsite-backup.ts`) and `scripts/ops/backup.mjs` fill on every run.
 *
 * - `failed` — the newest run (any status, drills aside) failed, or its requested off-site copy
 *   failed. A failure is visible at once, not only once the last good backup ages out;
 * - `ok` — the newest successful dump finished within the window (26 h daily; 7 h once the
 *   6-hourly job is on), and, when that dump asked for an off-site copy, an off-site copy was
 *   uploaded within the same window;
 * - `stale` — a dump or a requested off-site copy is older than the window;
 * - `not_configured` — no run was ever recorded (nothing set up yet) or the table cannot be
 *   read. Keyless host-only mode (off-site `skipped`) is `ok`, not stale: the trust centre then
 *   states host-only backups (56-29 default).
 *
 * Reported, never a reason for 503 by itself: a late or failed backup is an alert (56-23), not an
 * outage.
 */

export type BackupCheckState = 'ok' | 'stale' | 'failed' | 'not_configured';

export interface BackupRunReading {
  /** `ok | failed`; a reading without it is a successful run (the pre-OFFSITE-BACKUP shape). */
  readonly status?: string;
  readonly finishedAt: Date;
  readonly offsiteStatus: string;
  readonly offsiteAt: Date | null;
}

export const BACKUP_WINDOW_DAILY_HOURS = 26;
export const BACKUP_WINDOW_SIXHOURLY_HOURS = 7;

/** `runs`: the recent non-drill runs (successful and failed), newest first. */
export function evaluateBackupHealth(
  runs: readonly BackupRunReading[],
  now: Date,
  options: { readonly sixHourly?: boolean } = {},
): BackupCheckState {
  const latest = runs[0];
  if (latest === undefined) return 'not_configured';
  if (latest.status === 'failed' || latest.offsiteStatus === 'failed') return 'failed';
  const succeeded = runs.filter((r) => r.status === undefined || r.status === 'ok');
  const newest = succeeded[0];
  if (newest === undefined) return 'failed';
  const hours =
    options.sixHourly === true ? BACKUP_WINDOW_SIXHOURLY_HOURS : BACKUP_WINDOW_DAILY_HOURS;
  const fresh = (at: Date | null): boolean =>
    at !== null && now.getTime() - at.getTime() <= hours * 3_600_000;
  if (!fresh(newest.finishedAt)) return 'stale';
  if (newest.offsiteStatus === 'skipped' || newest.offsiteStatus === 'not_requested') return 'ok';
  // Off-site requested: the newest uploaded copy (in any run) must be inside the daily window.
  const lastOffsite = succeeded.find((r) => r.offsiteStatus === 'uploaded')?.offsiteAt ?? null;
  const offsiteFresh =
    lastOffsite !== null &&
    now.getTime() - lastOffsite.getTime() <= BACKUP_WINDOW_DAILY_HOURS * 3_600_000;
  return offsiteFresh ? 'ok' : 'stale';
}

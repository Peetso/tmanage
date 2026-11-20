/**
 * 56-17 follow-up: the 24-month retention purge of `security_reports` (data-inventory row
 * `security_reports`, migration 0262). Once a day in loop mode, every report whose `created_at` is
 * older than {@link SECURITY_REPORT_RETENTION_MONTHS} months is deleted, in
 * {@link SECURITY_REPORT_PURGE_BATCH}-row batches ordered by id (the bound rides
 * `ix_security_reports_created`), at most {@link SECURITY_REPORT_PURGE_MAX_BATCHES} batches a run;
 * the next day's run takes any rest.
 *
 * - The bound is computed here from a JS `Date` and bound as a parameter — never the database's
 *   `NOW()` (an admin pool's clock is SYSTEM, not UTC).
 * - Each DELETE repeats the bound, so a row whose id was listed cannot be removed unless it is
 *   still past it.
 * - One platform audit row per run, `platform.security_reports_purged`, carrying the count and the
 *   bound only — never a reference, a title or an address. The worker has no admin, so the actor is
 *   the {@link SYSTEM_ACTOR_ID} sentinel (`platform_admin_audit_events.actor_user_id` has no FK).
 * - `security_reports` is global (NON_TENANT_TABLES): no organization scope applies.
 *
 * This file holds no SQL; `common/database/security-report-purge-store.ts` does (worker grants:
 * SELECT and DELETE on `security_reports`, INSERT on `platform_admin_audit_events`).
 */

export const SECURITY_REPORT_RETENTION_MONTHS = 24;
export const SECURITY_REPORT_PURGE_BATCH = 500;
export const SECURITY_REPORT_PURGE_MAX_BATCHES = 20;
export const SECURITY_REPORT_PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const SECURITY_REPORT_PURGE_ACTION = 'platform.security_reports_purged';
/** The platform audit actor for a job no admin started. */
export const SYSTEM_ACTOR_ID = '00000000-0000-0000-0000-000000000000';
export const SYSTEM_ACTOR_EMAIL = 'system@tmanage.invalid';

/** `now` minus the retention, in UTC; a day the target month lacks clamps to its last day. */
export function securityReportCutoff(now: Date): Date {
  const months = now.getUTCFullYear() * 12 + now.getUTCMonth() - SECURITY_REPORT_RETENTION_MONTHS;
  const year = Math.floor(months / 12);
  const month = months - year * 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(
      year,
      month,
      Math.min(now.getUTCDate(), lastDay),
      now.getUTCHours(),
      now.getUTCMinutes(),
      now.getUTCSeconds(),
      now.getUTCMilliseconds(),
    ),
  );
}

/** The statements the purge needs. Faked by the unit test. */
export interface SecurityReportPurgeStore {
  /** Ids of reports created before `cutoff`, ordered by id, after `afterId`. */
  listExpired(cutoff: Date, afterId: string | null, limit: number): Promise<readonly string[]>;
  /** Delete those ids that are still before `cutoff`; returns the rows removed. */
  deleteExpired(ids: readonly string[], cutoff: Date): Promise<number>;
  /** The run's count-only platform audit row. */
  audit(deleted: number, cutoff: Date): Promise<void>;
}

export interface SecurityReportPurgeResult {
  readonly deleted: number;
  readonly cutoff: string;
  /** True when the batch cap stopped the run with rows possibly left. */
  readonly capped: boolean;
}

export async function purgeSecurityReports(deps: {
  readonly store: SecurityReportPurgeStore;
  readonly now?: () => Date;
  readonly batch?: number;
  readonly maxBatches?: number;
}): Promise<SecurityReportPurgeResult> {
  const cutoff = securityReportCutoff((deps.now ?? (() => new Date()))());
  const batch = Math.max(1, Math.trunc(deps.batch ?? SECURITY_REPORT_PURGE_BATCH));
  const maxBatches = deps.maxBatches ?? SECURITY_REPORT_PURGE_MAX_BATCHES;
  let deleted = 0;
  let cursor: string | null = null;
  let capped = false;
  for (let round = 0; ; round += 1) {
    if (round >= maxBatches) {
      capped = true;
      break;
    }
    const ids = await deps.store.listExpired(cutoff, cursor, batch);
    if (ids.length === 0) break;
    deleted += await deps.store.deleteExpired(ids, cutoff);
    if (ids.length < batch) break;
    cursor = ids[ids.length - 1] as string;
  }
  await deps.store.audit(deleted, cutoff);
  return { deleted, cutoff: cutoff.toISOString(), capped };
}

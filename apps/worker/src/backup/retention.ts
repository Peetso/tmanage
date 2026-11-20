/**
 * OFFSITE-BACKUP. Which off-site backups to keep: a grandfather-father-son rotation with two
 * generations (7 daily, 4 weekly), bounded by a byte budget under the free tier.
 *
 * - **daily**: the newest backup of each of the 7 newest UTC days that have one;
 * - **weekly**: the newest backup of each of the 4 newest ISO weeks that have one (a weekly
 *   can also be a daily; the rotation keeps at most 11 backups);
 * - **budget**: when the kept set is larger than `maxBytes`, the oldest kept backups are dropped
 *   until it fits; the newest backup is never dropped by the budget;
 * - **incomplete** backups (a dump without its manifest: the upload of the manifest is the
 *   commit point) are deleted once they are older than a day, and never count as kept.
 *
 * The OCI console states this tenancy's Always Free limit as "10 GiB of Object Storage and 10 GiB
 * of Archive Storage" (20 GiB combined), plus 50,000 Object Storage API requests a month. The
 * bucket is Standard tier, so only the 10 GiB of Object Storage applies. The default budget,
 * {@link DEFAULT_OFFSITE_MAX_BYTES}, is 8 GiB: it leaves 2 GiB free for the peak of a run (the
 * new backup is uploaded before the old ones are deleted) and for anything else in the tenancy.
 */

export const RETAIN_DAILY = 7;
export const RETAIN_WEEKLY = 4;
/** 8 GiB (8,589,934,592 bytes): four fifths of the 10 GiB Standard-tier allowance. */
export const DEFAULT_OFFSITE_MAX_BYTES = 8 * 1024 ** 3;
/** The Always Free Standard-tier Object Storage allowance, 10 GiB (10,737,418,240 bytes). */
export const FREE_TIER_BYTES = 10 * 1024 ** 3;
/** The Always Free Object Storage API allowance per month. */
export const FREE_TIER_REQUESTS_PER_MONTH = 50_000;

const STAMP = /^\d{8}T\d{6}Z$/u;

export interface OffsiteBackup {
  readonly stamp: string;
  readonly bytes: number;
  readonly complete: boolean;
}

export interface RetentionPlan {
  readonly keep: readonly string[];
  readonly remove: readonly string[];
  readonly keptBytes: number;
}

export function isStamp(value: string): boolean {
  return STAMP.test(value);
}

/** `20261120T030000Z` back to its instant. */
export function stampToDate(stamp: string): Date {
  if (!isStamp(stamp)) throw new Error(`not a backup stamp: ${stamp}`);
  return new Date(
    `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z`,
  );
}

/** The UTC stamp of an instant, to the second. */
export function stampOf(at: Date): string {
  return at
    .toISOString()
    .replace(/[-:]/gu, '')
    .replace(/\.\d{3}/u, '');
}

/** ISO 8601 week of a UTC date, as `YYYY-Www` (the week-numbering year, Thursday rule). */
export function isoWeek(at: Date): string {
  const d = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  const day = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${String(d.getUTCFullYear())}-W${String(week).padStart(2, '0')}`;
}

export function planRetention(
  backups: readonly OffsiteBackup[],
  now: Date,
  maxBytes: number = DEFAULT_OFFSITE_MAX_BYTES,
): RetentionPlan {
  const valid = backups.filter((b) => isStamp(b.stamp));
  const complete = valid.filter((b) => b.complete).sort((a, b) => (a.stamp < b.stamp ? 1 : -1));
  const kept = new Set<string>();
  const days = new Set<string>();
  const weeks = new Set<string>();
  for (const b of complete) {
    const day = b.stamp.slice(0, 8);
    if (!days.has(day) && days.size < RETAIN_DAILY) {
      days.add(day);
      kept.add(b.stamp);
    }
    const week = isoWeek(stampToDate(b.stamp));
    if (!weeks.has(week) && weeks.size < RETAIN_WEEKLY) {
      weeks.add(week);
      kept.add(b.stamp);
    }
  }
  // Budget: drop the oldest kept backups until the set fits; the newest always stays.
  const keptNewestFirst = complete.filter((b) => kept.has(b.stamp));
  let keptBytes = keptNewestFirst.reduce((sum, b) => sum + b.bytes, 0);
  for (let i = keptNewestFirst.length - 1; i > 0 && keptBytes > maxBytes; i -= 1) {
    const b = keptNewestFirst[i];
    if (b === undefined) continue;
    kept.delete(b.stamp);
    keptBytes -= b.bytes;
  }
  const dayMs = 86_400_000;
  const remove = valid
    .filter((b) =>
      b.complete ? !kept.has(b.stamp) : now.getTime() - stampToDate(b.stamp).getTime() > dayMs,
    )
    .map((b) => b.stamp);
  return {
    keep: [...kept].sort().reverse(),
    remove: [...new Set(remove)].sort(),
    keptBytes,
  };
}

/**
 * 57-14 / GROWTH-FIX — when the platform growth figures count as current, decided once here.
 *
 * The worker's rollup reruns on boot when its newest `computed_at` is older than the window, and
 * nightly after 02:00 UTC; the API's Growth view and `GET /healthz/deep` call the figures stale
 * past the same window. One number, so the job, the page and the health check never disagree.
 */

/** A nightly job plus two hours of slack: past this the figures are stale. */
export const GROWTH_STALE_HOURS = 26;

export const GROWTH_STALE_MS = GROWTH_STALE_HOURS * 3_600_000;

/** `none`: no figures were ever computed; `stale`: the newest is older than the window. */
export type GrowthFreshness = 'fresh' | 'stale' | 'none';

export function growthFreshness(computedAt: Date | null, now: Date): GrowthFreshness {
  if (computedAt === null || Number.isNaN(computedAt.getTime())) return 'none';
  return now.getTime() - computedAt.getTime() > GROWTH_STALE_MS ? 'stale' : 'fresh';
}

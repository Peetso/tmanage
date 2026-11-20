import { growthFreshness } from '@tmanage/domain';

/**
 * GROWTH-FIX. The `growth` reading of `GET /healthz/deep`: whether the platform growth figures
 * (`platform_growth_rollups`, 0284, written by the worker's `growth-rollup` job) are current.
 *
 * - `ok` — the newest `computed_at` is inside the domain's window (`GROWTH_STALE_HOURS`);
 * - `stale` — it is older, or no figures were ever computed (the job is not running: the
 *   2026-11-20 live defect, where the single app never scheduled it);
 * - `not_configured` — the table cannot be read.
 *
 * Reported, never a reason for 503 by itself (ENGINEERING-STANDARD RT-4: sweeps are deep health,
 * not readiness), the same as `backups`.
 */
export type GrowthCheckState = 'ok' | 'stale' | 'not_configured';

export function growthCheckOf(computedAt: Date | null, now: Date): GrowthCheckState {
  return growthFreshness(computedAt, now) === 'fresh' ? 'ok' : 'stale';
}

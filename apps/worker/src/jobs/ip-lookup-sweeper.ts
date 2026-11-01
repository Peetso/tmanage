/**
 * R12 (R1). The retention sweep of the global IP cache `ip_lookups` (migration 0280). Once a day
 * in loop mode, every row whose `last_seen_at` is older than `GEOIP_RETENTION_DAYS` (default 400,
 * the longest audit retention) is deleted, {@link IP_LOOKUP_SWEEP_BATCH} rows at a time, at most
 * {@link IP_LOOKUP_SWEEP_MAX_BATCHES} batches a run; the next day's run takes any rest.
 *
 * - The bound is a bound JS `Date`, never the database's `NOW()` (an admin pool's clock is SYSTEM).
 * - The cache is derived data (a re-lookup rebuilds a row), so no audit row is written.
 * - The worker touches `ip_lookups` alone (grants: SELECT, DELETE).
 *
 * This file holds no SQL; `common/database/ip-lookup-sweeper-store.ts` does.
 */

export const IP_LOOKUP_SWEEP_BATCH = 1000;
export const IP_LOOKUP_SWEEP_MAX_BATCHES = 50;
export const IP_LOOKUP_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_GEOIP_RETENTION_DAYS = 400;

export interface IpLookupSweepStore {
  /** Delete up to `limit` rows last seen before `cutoff`; returns the rows removed. */
  deleteUnseenSince(cutoff: Date, limit: number): Promise<number>;
}

export function ipLookupCutoff(now: Date, retentionDays: number): Date {
  return new Date(now.getTime() - Math.max(1, Math.trunc(retentionDays)) * 86_400_000);
}

export async function sweepIpLookups(deps: {
  readonly store: IpLookupSweepStore;
  readonly retentionDays?: number;
  readonly now?: () => Date;
  readonly batch?: number;
  readonly maxBatches?: number;
}): Promise<{ readonly deleted: number; readonly cutoff: string; readonly capped: boolean }> {
  const now = (deps.now ?? (() => new Date()))();
  const cutoff = ipLookupCutoff(now, deps.retentionDays ?? DEFAULT_GEOIP_RETENTION_DAYS);
  const batch = Math.max(1, Math.trunc(deps.batch ?? IP_LOOKUP_SWEEP_BATCH));
  const maxBatches = deps.maxBatches ?? IP_LOOKUP_SWEEP_MAX_BATCHES;
  let deleted = 0;
  for (let round = 0; round < maxBatches; round += 1) {
    const removed = await deps.store.deleteUnseenSince(cutoff, batch);
    deleted += removed;
    if (removed < batch) return { deleted, cutoff: cutoff.toISOString(), capped: false };
  }
  return { deleted, cutoff: cutoff.toISOString(), capped: true };
}

/** Loop mode: one pass now and one every {@link IP_LOOKUP_SWEEP_INTERVAL_MS}; stops on `signal`. */
export async function runIpLookupSweepLoop(
  store: IpLookupSweepStore,
  retentionDays: number,
  signal: AbortSignal,
  onError: (error: unknown) => void = (error) =>
    console.error('[worker] IP lookup sweep failed', error),
  intervalMs = IP_LOOKUP_SWEEP_INTERVAL_MS,
): Promise<void> {
  while (!signal.aborted) {
    try {
      const result = await sweepIpLookups({ store, retentionDays });
      if (result.deleted > 0) {
        console.warn(`[worker] IP lookup sweep: ${String(result.deleted)} row(s) removed`);
      }
    } catch (error) {
      onError(error);
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, intervalMs);
      signal.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true });
    });
  }
}

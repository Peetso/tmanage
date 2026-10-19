// Backoff schedule for respawning the `next start` web child after it exits (OPS-01).
//
// The single-process server used to die with its web child: any `next start` exit called
// process.exit, taking the in-process API and the public port down too. A transient web crash
// must not be a whole-app outage. Instead the server keeps serving and respawns the child after a
// delay that grows exponentially with each consecutive crash and is capped, so a child that can
// never start degrades to one attempt every WEB_RESTART_CAP_MS rather than a hot restart loop.
// A child that stays up past WEB_HEALTHY_MS resets the count, so a later isolated crash restarts
// from the short delay again.

/** First restart fires almost immediately; each further consecutive crash doubles the wait. */
export const WEB_RESTART_BASE_MS = 500;
/** Ceiling on the backoff: a wedged child is retried at most this often. */
export const WEB_RESTART_CAP_MS = 30_000;
/** A child alive at least this long is considered healthy and clears the backoff. */
export const WEB_HEALTHY_MS = 60_000;

/**
 * Delay before the nth consecutive restart (attempt is 0-based): baseMs * 2**attempt, capped at
 * capMs. A non-finite or negative attempt is treated as 0; an overflow to Infinity returns capMs.
 */
export function webRestartDelayMs(
  attempt,
  { baseMs = WEB_RESTART_BASE_MS, capMs = WEB_RESTART_CAP_MS } = {},
) {
  const n = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0;
  const raw = baseMs * 2 ** n;
  return Number.isFinite(raw) ? Math.min(capMs, raw) : capMs;
}

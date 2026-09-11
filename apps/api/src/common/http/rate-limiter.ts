/**
 * A fixed-window request limiter, in process — `04-SECURITY-PRIVACY` §6's "rate limiting,
 * abuse detection" and `26-THREAT-MODELS` §2's "rate limits at every crossing", for the
 * one crossing this API exposes with no session: the part PUT (FILE-001b). The security
 * review of 2026-09-04 found `RATE_LIMIT_*` configured and consumed by nothing.
 *
 * In process rather than in the database because the bootstrap profile runs one API
 * process (`50-BOOTSTRAP` §3) and the sign-in lockout already pays a table for the case
 * that must survive a restart; a burst of anonymous PUTs need not. Two consequences are
 * stated so nobody relies on more: a restart forgets every window, and a second process
 * would count separately.
 *
 * The map is bounded. A caller who rotates addresses could otherwise grow it without end;
 * at `maxKeys` the oldest window is dropped, which at worst admits that caller a little
 * more — never less than the limit says — and holds memory to a known ceiling.
 */

export interface FixedWindowLimiterOptions {
  readonly windowMs: number;
  /** Requests admitted per key per window. The one over it is refused. */
  readonly max: number;
  /** Distinct keys remembered at once; the oldest window goes first. */
  readonly maxKeys?: number;
  readonly now?: () => number;
}

/** `true` when the request may proceed; `false` when this key has used its window. */
export type RequestAdmission = (key: string) => boolean;

/**
 * The same limiter with the question and the charge separated.
 *
 * `createFixedWindowLimiter` asks and charges in one call, which is all a single-key caller
 * needs. A caller holding **several** budgets that must agree before any of them is spent
 * cannot use that shape: charging the first budget before the second has been consulted spends
 * it on an attempt the second refuses. `sign-in-abuse-control.ts` is that caller, and the
 * asymmetry it produced was a defect the re-review of 2026-09-07 found (N-1) — a person behind
 * a shared address burned their own account budget on attempts the *source* budget refused, and
 * stayed refused past the end of the window that refused them.
 *
 * So `test` answers without mutating anything and `commit` performs the charge, and both take
 * the instant explicitly. The instant is the caller's, not the limiter's, for one reason worth
 * stating: a caller testing three budgets and then committing three would otherwise sample the
 * clock six times and could straddle a window boundary between the question and the answer.
 * One sample per decision makes the pair exact.
 */
export interface TwoPhaseFixedWindowLimiter {
  /**
   * Would a charge at `at` be admitted? Reads only — no count moves, no window starts, no key
   * is evicted, and a key's recency is not refreshed.
   */
  test(key: string, at: number): boolean;
  /** Charge the key at `at`, returning the same verdict `test(key, at)` returns. */
  commit(key: string, at: number): boolean;
  /** The clock this limiter was built with, so a caller samples the same one. */
  now(): number;
}

interface Window {
  startedAt: number;
  count: number;
}

/**
 * Distinct keys one limiter remembers when the caller names no ceiling. Exported so a caller
 * that keeps its own per-key memory alongside a limiter (`sign-in-abuse-control.ts`) bounds it
 * to the same number rather than to a copy of it that is free to drift.
 */
export const FIXED_WINDOW_DEFAULT_MAX_KEYS = 10_000;

export function createTwoPhaseFixedWindowLimiter(
  options: FixedWindowLimiterOptions,
): TwoPhaseFixedWindowLimiter {
  const windowMs = Math.max(1, options.windowMs);
  const max = Math.max(1, options.max);
  const maxKeys = Math.max(1, options.maxKeys ?? FIXED_WINDOW_DEFAULT_MAX_KEYS);
  const now = options.now ?? Date.now;
  // Insertion order is age: a key touched again is deleted and re-set, so the first entry
  // is always the one least recently seen.
  const windows = new Map<string, Window>();

  /** The window this key is in at `at`, or `undefined` when `at` starts a fresh one. */
  const live = (key: string, at: number): Window | undefined => {
    const existing = windows.get(key);
    return existing && at - existing.startedAt < windowMs ? existing : undefined;
  };

  return {
    now,
    test(key, at) {
      const existing = live(key, at);
      // A fresh window's first charge is always admitted, because `max` is at least 1.
      return existing === undefined || existing.count + 1 <= max;
    },
    commit(key, at) {
      const existing = live(key, at);
      if (existing) {
        existing.count += 1;
        windows.delete(key);
        windows.set(key, existing);
        return existing.count <= max;
      }
      windows.delete(key);
      if (windows.size >= maxKeys) {
        const oldest = windows.keys().next().value;
        if (oldest !== undefined) windows.delete(oldest);
      }
      windows.set(key, { startedAt: at, count: 1 });
      return true;
    },
  };
}

export function createFixedWindowLimiter(options: FixedWindowLimiterOptions): RequestAdmission {
  // Ask and charge in one call — the shape a single-budget caller wants, expressed in terms of
  // the two-phase limiter rather than duplicating its arithmetic.
  const limiter = createTwoPhaseFixedWindowLimiter(options);
  return (key) => limiter.commit(key, limiter.now());
}

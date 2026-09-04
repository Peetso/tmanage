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

interface Window {
  startedAt: number;
  count: number;
}

const DEFAULT_MAX_KEYS = 10_000;

export function createFixedWindowLimiter(options: FixedWindowLimiterOptions): RequestAdmission {
  const windowMs = Math.max(1, options.windowMs);
  const max = Math.max(1, options.max);
  const maxKeys = Math.max(1, options.maxKeys ?? DEFAULT_MAX_KEYS);
  const now = options.now ?? Date.now;
  // Insertion order is age: a key touched again is deleted and re-set, so the first entry
  // is always the one least recently seen.
  const windows = new Map<string, Window>();

  return (key) => {
    const at = now();
    const existing = windows.get(key);
    if (existing && at - existing.startedAt < windowMs) {
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
  };
}

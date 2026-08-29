/**
 * Retry backoff — `24-EVENT-CATALOG` §2: "Retry uses exponential backoff".
 *
 * Pure arithmetic, in a file of its own so the unit suite can enumerate it without a
 * database: `base * 2^(attempts - 1)`, capped. `attempts` is the count *after* the failure
 * being scheduled — the first retry waits one base interval, not zero.
 */
export function backoffDelayMs(attempts: number, baseMs: number, capMs: number): number {
  if (attempts < 1) return 0;
  // 2^30 base intervals is past any real cap; clamping the exponent keeps the arithmetic
  // inside safe-integer territory instead of overflowing to Infinity and comparing wrong.
  const exponent = Math.min(attempts - 1, 30);
  return Math.min(capMs, baseMs * 2 ** exponent);
}

import type { TenantGuardEvent } from './tenant-guard.js';

/**
 * LOGQUIET-b, tightened by QA-FIX-R — what reaches the log from the tenant guard.
 *
 * A real violation (no `allowedReason`) is written every time: each one is a statement that was
 * refused, or in `observe` served, without its tenant predicate.
 *
 * An audited `allowUnscoped` escape (the minute sweeps, the relay, the sign-in bootstrap reads)
 * carries its reviewed reason and repeats the same statement on every pass. It is written once
 * per statement per process start, so the record that the escape is in use stays, and every
 * repeat goes to the `debug` sink, which production leaves unset (`LOG_LEVEL=info`).
 *
 * "The same statement" is the guard's shape with the bound-value lists folded. An
 * `IN (?, ?, ?)` over a batch of ids, or a multi-row `VALUES (?, ?), (?, ?)`, renders one more
 * `?` per value, so the raw fingerprint changes with the batch size and a pass over N rows
 * looked like a new statement. Folding the lists keys the line on the statement, not on its
 * batch size.
 *
 * The seen-set is capped so an unexpected stream of distinct statements cannot grow it without
 * bound. Past the cap, first sightings go to `debug` too and one line says the cap was reached.
 * Before QA-FIX-R they were written every time again, which is the flood the cap exists to stop.
 */
export const ALLOWED_FINGERPRINTS_CAP = 1_000;

export interface GuardEventLogOptions {
  /** Repeats of an audited escape. Unset in production (`LOG_LEVEL` above `debug`). */
  readonly debug?: (event: TenantGuardEvent) => void;
  /** Called once, when the seen-set first refuses a new statement at the cap. */
  readonly capReached?: (cap: number) => void;
}

/**
 * The dedupe key of an audited escape: its reason plus its shape with every run of bound
 * parameters, and every run of identical parenthesised tuples, folded to one. Shapes are the
 * guard's space-joined token rendering (`renderShape` in `tenant-guard.ts`), so a run of
 * parameters reads `? , ? , ?`.
 */
export function allowedStatementKey(event: TenantGuardEvent): string {
  const folded = event.shape
    .replace(/\?(?: , \?)+/g, '?')
    .replace(/(\( [^()]* \))(?: , \1)+/g, '$1');
  return `${event.allowedReason ?? ''}\u0000${folded}`;
}

export function createGuardEventLog(
  write: (event: TenantGuardEvent) => void,
  options: GuardEventLogOptions = {},
): (event: TenantGuardEvent) => void {
  const seen = new Set<string>();
  let capReported = false;
  return (event) => {
    if (event.allowedReason === undefined) {
      write(event);
      return;
    }
    const key = allowedStatementKey(event);
    if (seen.has(key)) {
      options.debug?.(event);
      return;
    }
    if (seen.size >= ALLOWED_FINGERPRINTS_CAP) {
      if (!capReported) {
        capReported = true;
        options.capReached?.(ALLOWED_FINGERPRINTS_CAP);
      }
      options.debug?.(event);
      return;
    }
    seen.add(key);
    write(event);
  };
}

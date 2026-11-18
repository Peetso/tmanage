import type { TenantGuardEvent } from './tenant-guard.js';

/**
 * LOGQUIET-b — what reaches the log from the tenant guard.
 *
 * A real violation (no `allowedReason`) is logged every time: each one is a statement that was
 * refused, or in `observe` served, without its tenant predicate. An audited `allowUnscoped`
 * escape (the minute sweeps, the relay) carries its reviewed reason and repeats the same
 * statement every pass, so it is logged once per statement fingerprint per process start: the
 * record that the escape is in use stays, the line a minute does not. The set is capped so an
 * unexpected stream of distinct fingerprints cannot grow it without bound; past the cap the
 * escapes are logged every time again, as before.
 */
export const ALLOWED_FINGERPRINTS_CAP = 1_000;

export function createGuardEventLog(
  write: (event: TenantGuardEvent) => void,
): (event: TenantGuardEvent) => void {
  const seen = new Set<string>();
  return (event) => {
    if (event.allowedReason !== undefined) {
      if (seen.has(event.fingerprint)) return;
      if (seen.size < ALLOWED_FINGERPRINTS_CAP) seen.add(event.fingerprint);
    }
    write(event);
  };
}

/**
 * DC-3 / RT-3. The `leader` reading of `GET /healthz/deep`: which copy of the single Hostinger app
 * holds the leader lease (`runtime_leases`, migration 0384) and so runs the relay, the sweeps and
 * the scheduled jobs.
 *
 * - `held` + `instance` — a live lease; `instance` is the holder's opaque random tag (no host
 *   name, path or pid), the same tag each copy logs at boot beside its pid;
 * - `vacant` — no row, or the row expired: no copy leads right now (a takeover is due, or no copy
 *   runs the relay or sweeps);
 * - `not_configured` — the table cannot be read.
 *
 * Info only, never a reason for 503 (RT-4: background duties are deep health, not readiness).
 * Their effect is already judged by `worker` (the relay heartbeat) and `growth`.
 */
export type LeaderCheck =
  | { readonly state: 'held'; readonly instance: string }
  | { readonly state: 'vacant' }
  | { readonly state: 'not_configured' };

export function leaderCheckOf(
  row: { readonly holder: string; readonly expiresAt: Date } | null,
  now: Date,
): LeaderCheck {
  if (row === null || row.holder === '' || row.expiresAt.getTime() < now.getTime()) {
    return { state: 'vacant' };
  }
  return { state: 'held', instance: row.holder };
}

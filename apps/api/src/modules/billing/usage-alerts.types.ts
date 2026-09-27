/**
 * Billing & entitlements (module 19, x200). The metric allowlist shared by the usage-alerts service and
 * repository. Kept in its own module (no driver handle, no Nest wiring) so both the boundary-restricted
 * repository and the plain service may import it without either reaching for the other.
 */

/**
 * The metered dimensions a usage-alert rule may watch. Mirrors the DB `VARCHAR` allowlist
 * (`schema.ts` `BILLING_USAGE_ALERT_METRICS`); a value outside this set is a 400 in the service, never
 * stored.
 */
export const USAGE_ALERT_METRICS = ['seats', 'storage', 'api'] as const;
export type UsageAlertMetric = (typeof USAGE_ALERT_METRICS)[number];

/**
 * The `usage_counters.metric_key` each alert metric reads its current band from. `storage` reuses the
 * live storage-bytes counter (0021); `seats` and `api` name their counters so a future counter write
 * flows straight through — until one exists the band is absent and reads as 0% (not breached).
 */
export const METRIC_COUNTER_KEYS: Readonly<Record<UsageAlertMetric, string>> = Object.freeze({
  seats: 'seats.active',
  storage: 'storage.bytes',
  api: 'api.requests',
});

import { DEFAULT_AUTO_TRACKING_POLICY, isAutoTrackingPolicy } from '@tmanage/domain';
import type { AutoTrackingPolicy } from '@tmanage/domain';

/**
 * FIX-2026-11-10 — "Automatic time tracking", the company owner's choice: `off` (nobody),
 * `optional` (each person decides, the default) or `required` (everybody's time is tracked while
 * they use their computer). Stored in `org_settings` under `auto_time_tracking` (no column, no
 * migration); written only through the owner-only, audited `PATCH …/time/auto/policy`.
 */
export const AUTO_TIME_TRACKING_KEY = 'auto_time_tracking' as const;

/** The stored value read back as a policy; anything unrecognised is the default. */
export function storedAutoTrackingPolicy(stored: string | undefined): AutoTrackingPolicy {
  return isAutoTrackingPolicy(stored) ? stored : DEFAULT_AUTO_TRACKING_POLICY;
}

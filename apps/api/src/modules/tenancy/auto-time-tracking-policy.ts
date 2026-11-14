import {
  DEFAULT_AUTO_TRACKING_POLICY,
  IDLE_THRESHOLD_DEFAULT_MINUTES,
  IDLE_THRESHOLD_MAX_MINUTES,
  IDLE_THRESHOLD_MIN_MINUTES,
  isAutoTrackingPolicy,
} from '@tmanage/domain';
import type { AutoTrackingPolicy } from '@tmanage/domain';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';
import type { OrgSettingsRepository } from './org-settings.repository.js';

/**
 * FIX-2026-11-10 — "Automatic time tracking", the company owner's choice: `off` (nobody),
 * `optional` (each person decides, the default) or `required` (everybody's time is tracked while
 * they use their computer), and the largest idle threshold anyone may pick. Stored in
 * `org_settings` under `auto_time_tracking` and `auto_time_tracking_max_idle` (no column, no
 * migration); written only through the owner-only, audited `PATCH …/time/auto/policy`.
 */
export const AUTO_TIME_TRACKING_KEY = 'auto_time_tracking' as const;
export const AUTO_TIME_TRACKING_MAX_IDLE_KEY = 'auto_time_tracking_max_idle' as const;
/**
 * The company's time zone (`org_settings.default_timezone`): automatic time and the manual timer
 * are filed by its days.
 */
export const COMPANY_TIME_ZONE_KEY = 'default_timezone' as const;

/**
 * The company's time zone; an absent or blank one reads as UTC (an unknown name reads as UTC in
 * `localDateOf`). The one reader, so every entry is filed on the same company calendar.
 */
export async function companyTimeZone(
  runner: TenantQueryRunner,
  context: TenantContext,
  settings: Pick<OrgSettingsRepository, 'findByKey'>,
): Promise<string> {
  const row = await settings.findByKey(runner, context, COMPANY_TIME_ZONE_KEY);
  return row?.settingValue?.trim() || 'UTC';
}

/** The stored value read back as a policy; anything unrecognised is the default. */
export function storedAutoTrackingPolicy(stored: string | undefined): AutoTrackingPolicy {
  return isAutoTrackingPolicy(stored) ? stored : DEFAULT_AUTO_TRACKING_POLICY;
}

/** The stored owner maximum idle threshold, in minutes; anything unrecognised is the default. */
export function storedMaxIdleMinutes(stored: string | undefined): number {
  const minutes = stored === undefined ? Number.NaN : Number(stored);
  return Number.isInteger(minutes) &&
    minutes >= IDLE_THRESHOLD_MIN_MINUTES &&
    minutes <= IDLE_THRESHOLD_MAX_MINUTES
    ? minutes
    : IDLE_THRESHOLD_DEFAULT_MINUTES;
}

import type { OrgSettingsView } from './org-settings';

/**
 * C6 — the organization settings the pre-A11 screen edited and the A11 card dropped: the default
 * timezone, the working week, the operating template, the re-authentication window and whether
 * new projects are client-visible by default. The API's allowlist (`org-settings.allowlist.ts`)
 * still holds and validates every one; this is the card's view of them.
 */
export const DEFAULT_SETTING_KEYS = [
  'default_timezone',
  'working_week',
  'operating_template',
  'require_reauth_minutes',
  'client_visible_project_default',
] as const;

export type DefaultSettingKey = (typeof DEFAULT_SETTING_KEYS)[number];

/** The API's defaults for each key (no row written yet). */
export const DEFAULT_SETTING_VALUES: Readonly<Record<DefaultSettingKey, string>> = {
  default_timezone: 'UTC',
  working_week: 'mon-fri',
  operating_template: 'delivery-client-review',
  require_reauth_minutes: '0',
  client_visible_project_default: 'false',
};

export const WORKING_WEEK_OPTIONS = [
  { value: 'mon-fri', labelKey: 'CreateOrganizationScreen.weekMonFri' },
  { value: 'sun-thu', labelKey: 'CreateOrganizationScreen.weekSunThu' },
  { value: 'sat-wed', labelKey: 'CreateOrganizationScreen.weekSatWed' },
  { value: 'mon-sat', labelKey: 'CreateOrganizationScreen.weekMonSat' },
] as const;

export const OPERATING_TEMPLATE_OPTIONS = [
  { value: 'delivery-client-review', labelKey: 'OperatingTemplateScreen.tplDeliveryName' },
  { value: 'intake-commitment', labelKey: 'OperatingTemplateScreen.tplIntakeName' },
  { value: 'internal-delivery', labelKey: 'OperatingTemplateScreen.tplInternalName' },
  { value: 'empty', labelKey: 'OperatingTemplateScreen.tplEmptyName' },
] as const;

/** Each key's stored value from a settings read; a key the read lacks keeps its default. */
export function defaultSettings(
  view: OrgSettingsView | undefined,
): Record<DefaultSettingKey, string> {
  const values = new Map((view?.settings ?? []).map((entry) => [entry.key, entry.value]));
  const result = { ...DEFAULT_SETTING_VALUES };
  for (const key of DEFAULT_SETTING_KEYS) {
    const value = values.get(key);
    if (value !== undefined) result[key] = value;
  }
  return result;
}

/** The re-authentication window as the API accepts it: a whole number from 0 to 1440. */
export function isValidReauthMinutes(value: string): boolean {
  const trimmed = value.trim();
  return /^\d+$/.test(trimmed) && Number(trimmed) <= 1440;
}

/** The timezones the select offers, always including the stored one. */
export function timezoneOptions(current: string): readonly string[] {
  const intl = Intl as typeof Intl & { supportedValuesOf?: (key: string) => string[] };
  let zones: readonly string[] = [
    'UTC',
    'Africa/Cairo',
    'Asia/Dubai',
    'Asia/Riyadh',
    'Europe/London',
    'America/New_York',
  ];
  if (typeof intl.supportedValuesOf === 'function') {
    try {
      zones = ['UTC', ...intl.supportedValuesOf('timeZone').filter((zone) => zone !== 'UTC')];
    } catch {
      // keep the short list
    }
  }
  return current !== '' && !zones.includes(current) ? [current, ...zones] : zones;
}

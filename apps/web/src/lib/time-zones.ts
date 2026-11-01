import { TIME_ZONE_COUNTRIES } from './time-zones-data';

/**
 * The time zones every picker in the product offers — R9, "time zone should be all countries".
 *
 * One list for every field (profile, display preferences, quiet hours, meetings, organization
 * defaults, onboarding, Control Center), so a zone that can be chosen in one place can be chosen
 * in all of them:
 *
 * - **Every zone.** The static table (`time-zones-data.ts`, every canonical tzdata zone with its
 *   country, plus `UTC`) unioned with whatever the runtime itself enumerates through
 *   `Intl.supportedValuesOf('timeZone')`, so a runtime that cannot enumerate still offers all of
 *   them and a runtime with a newer tzdata adds its new zones.
 * - **Current names.** ICU still reports some zones under retired names (`Asia/Calcutta`,
 *   `Europe/Kiev` …); they are folded into their current names so a zone is never listed twice.
 *   A stored retired name still resolves everywhere, and is still shown as the current value.
 * - **The current value is always selectable**, even one the table has never heard of — a select
 *   that cannot show what is stored silently changes it on the next save.
 */

/** Retired tzdata names ICU still enumerates → the current name tzdata lists. */
export const LEGACY_TIME_ZONE_NAMES: Readonly<Record<string, string>> = {
  'Africa/Asmera': 'Africa/Asmara',
  'America/Buenos_Aires': 'America/Argentina/Buenos_Aires',
  'America/Catamarca': 'America/Argentina/Catamarca',
  'America/Coral_Harbour': 'America/Atikokan',
  'America/Cordoba': 'America/Argentina/Cordoba',
  'America/Godthab': 'America/Nuuk',
  'America/Indianapolis': 'America/Indiana/Indianapolis',
  'America/Jujuy': 'America/Argentina/Jujuy',
  'America/Louisville': 'America/Kentucky/Louisville',
  'America/Mendoza': 'America/Argentina/Mendoza',
  'Asia/Calcutta': 'Asia/Kolkata',
  'Asia/Katmandu': 'Asia/Kathmandu',
  'Asia/Rangoon': 'Asia/Yangon',
  'Asia/Saigon': 'Asia/Ho_Chi_Minh',
  'Atlantic/Faeroe': 'Atlantic/Faroe',
  'Europe/Kiev': 'Europe/Kyiv',
  'Pacific/Enderbury': 'Pacific/Kanton',
  'Pacific/Ponape': 'Pacific/Pohnpei',
  'Pacific/Truk': 'Pacific/Chuuk',
};

/** The current tzdata name for a zone (a retired alias folds into it; anything else is kept). */
export function canonicalTimeZone(zone: string): string {
  return LEGACY_TIME_ZONE_NAMES[zone] ?? zone;
}

/**
 * Whether `zone` is an IANA time zone name the runtime can format in. `Intl` alone also accepts
 * bare offsets (`+03:00`), which are not zones and would never match a row in the list.
 */
export function isTimeZone(zone: string): boolean {
  if (zone.length === 0 || zone.length > 64 || !/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(zone)) {
    return false;
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** Every zone, current names only, `UTC` first and the rest in name order. */
export function allTimeZones(): readonly string[] {
  const zones = new Set<string>(Object.keys(TIME_ZONE_COUNTRIES));
  const intl = Intl as typeof Intl & { supportedValuesOf?: (key: string) => string[] };
  if (typeof intl.supportedValuesOf === 'function') {
    try {
      for (const zone of intl.supportedValuesOf('timeZone')) zones.add(canonicalTimeZone(zone));
    } catch {
      // The static table is already every zone.
    }
  }
  zones.delete('UTC');
  return ['UTC', ...[...zones].sort()];
}

/** "GMT+2", "GMT+5:30", "GMT-3" — the zone's offset at `at`; "GMT+0" for UTC itself. */
export function timeZoneOffset(zone: string, at: Date = new Date()): string {
  try {
    const value =
      new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'shortOffset' })
        .formatToParts(at)
        .find((part) => part.type === 'timeZoneName')?.value ?? 'GMT';
    return value === 'GMT' ? 'GMT+0' : value;
  } catch {
    return '';
  }
}

/** The offset in minutes east of UTC at `at`, for ordering; 0 when it cannot be read. */
export function timeZoneOffsetMinutes(zone: string, at: Date = new Date()): number {
  const match = /^GMT([+-])(\d{1,2})(?::(\d{2}))?$/.exec(timeZoneOffset(zone, at));
  if (!match) return 0;
  const minutes = Number(match[2]) * 60 + Number(match[3] ?? 0);
  return match[1] === '-' ? -minutes : minutes;
}

/** "Ho Chi Minh" for `Asia/Ho_Chi_Minh`, "Buenos Aires" for `America/Argentina/Buenos_Aires`. */
export function timeZoneCity(zone: string): string {
  const last = zone.split('/').pop() ?? zone;
  return last.replace(/_/g, ' ');
}

/** The zone's country in `locale` ("Egypt", "مصر"), or `''` when it has none or it is unknown. */
export function timeZoneCountry(zone: string, locale: string): string {
  const code = TIME_ZONE_COUNTRIES[canonicalTimeZone(zone)];
  if (!code) return '';
  try {
    return new Intl.DisplayNames([locale, 'en'], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
}

export interface TimeZoneLabelOptions {
  /** The locale the country is named in; Arabic also takes the Arabic comma. */
  readonly locale: string;
  /** The instant the offset is read at (a meeting's date, say); now by default. */
  readonly at?: Date;
  /** The name shown for `UTC`, which has no city or country. */
  readonly utcName?: string;
  /**
   * The heading a region is listed under, in the reader's language (`africa` → "Africa").
   * Without it the option has no `group` and the list is one flat west-to-east run.
   */
  readonly regionName?: (region: TimeZoneRegion) => string;
}

/** The regions the picker groups by — tzdata's own areas, in tzdata's order. */
export const TIME_ZONE_REGIONS = [
  'africa',
  'america',
  'antarctica',
  'arctic',
  'asia',
  'atlantic',
  'australia',
  'europe',
  'indian',
  'pacific',
] as const;
export type TimeZoneRegion = (typeof TIME_ZONE_REGIONS)[number];

/** The zone's region (`Africa/Cairo` → `africa`), or `null` for `UTC` and anything area-less. */
export function timeZoneRegion(zone: string): TimeZoneRegion | null {
  const area = canonicalTimeZone(zone).split('/')[0]?.toLowerCase() ?? '';
  return (TIME_ZONE_REGIONS as readonly string[]).includes(area) && zone.includes('/')
    ? (area as TimeZoneRegion)
    : null;
}

/** "(GMT+2) Cairo, Egypt" — offset, city, country; "(GMT+0) UTC" for UTC. */
export function timeZoneLabel(zone: string, options: TimeZoneLabelOptions): string {
  const offset = timeZoneOffset(zone, options.at);
  const prefix = offset === '' ? '' : `(${offset}) `;
  if (zone === 'UTC' || zone === 'Etc/UTC') return `${prefix}${options.utcName ?? 'UTC'}`;
  const city = timeZoneCity(zone);
  const country = timeZoneCountry(zone, options.locale);
  const comma = options.locale.toLowerCase().startsWith('ar') ? '، ' : ', ';
  return `${prefix}${country === '' || country === city ? city : `${city}${comma}${country}`}`;
}

export interface TimeZoneOption {
  readonly value: string;
  readonly label: string;
  /** The region heading, when `regionName` was given. */
  readonly group?: string;
}

/**
 * The picker's options: every zone, labelled, with `current` always present (kept under its
 * stored spelling, retired name or not). With `regionName` the zones are grouped by region —
 * area-less zones (`UTC`) first, then tzdata's order — and within a group, as without one,
 * ordered west to east by offset at `at` and then by label.
 */
export function timeZoneOptions(
  current: string,
  options: TimeZoneLabelOptions,
): readonly TimeZoneOption[] {
  const zones = [...allTimeZones()];
  const stored = current.trim();
  if (stored !== '' && !zones.includes(stored)) {
    // A retired name stands in for its current one rather than appearing next to it.
    const index = zones.indexOf(canonicalTimeZone(stored));
    if (index >= 0) zones[index] = stored;
    else zones.push(stored);
  }
  const regionName = options.regionName;
  return zones
    .map((zone) => {
      const region = regionName ? timeZoneRegion(zone) : null;
      return {
        value: zone,
        label: timeZoneLabel(zone, options),
        minutes: timeZoneOffsetMinutes(zone, options.at),
        rank: region === null ? -1 : TIME_ZONE_REGIONS.indexOf(region),
        group: region === null || !regionName ? undefined : regionName(region),
      };
    })
    .sort(
      (a, b) =>
        a.rank - b.rank || a.minutes - b.minutes || a.label.localeCompare(b.label, options.locale),
    )
    .map(({ value, label, group }) =>
      group === undefined ? { value, label } : { value, label, group },
    );
}

/** The browser's zone under its current name, `UTC` where it is not known. */
export function guessTimeZone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return zone ? canonicalTimeZone(zone) : 'UTC';
  } catch {
    return 'UTC';
  }
}

import { addWorkingDays } from './working-calendar.js';
import type { WorkingCalendar } from './working-calendar.js';

/**
 * 55-07 Natural defaults + 55-18 Calm notification profile — the pure rules that pick a sensible
 * starting value so a new company does not have to configure anything before it works.
 *
 * Everything here is a *default*: a value the caller stores or shows only when the person has not
 * chosen one. Nothing overrides a saved choice.
 */

/** The working weeks the org setting `working_week` accepts (mirrors `WORKING_WEEKS` in the API). */
export type NaturalWorkWeek = 'mon-fri' | 'sun-thu' | 'sat-wed' | 'mon-sat';

/**
 * Zones whose weekend is Friday–Saturday, so the working week is Sunday–Thursday.
 * Source: the official working weeks of Saudi Arabia, the UAE public sector (private sector varies),
 * Kuwait, Qatar, Bahrain, Oman, Egypt and Jordan (55-EASIEST-TO-USE-PROGRAM.md 55-07).
 */
const SUN_THU_ZONES: ReadonlySet<string> = new Set([
  'Asia/Riyadh',
  'Asia/Dubai',
  'Asia/Kuwait',
  'Asia/Qatar',
  'Asia/Bahrain',
  'Asia/Muscat',
  'Africa/Cairo',
  'Asia/Amman',
]);

/** The working week a company in `timeZone` most likely keeps: Sun–Thu in the table above, else Mon–Fri. */
export function workWeekForTimezone(timeZone: string | null | undefined): NaturalWorkWeek {
  return typeof timeZone === 'string' && SUN_THU_ZONES.has(timeZone.trim()) ? 'sun-thu' : 'mon-fri';
}

/** The display date formats (mirrors `DISPLAY_DATE_FORMATS` in the API). */
export type NaturalDateFormat = 'iso' | 'us' | 'eu' | 'long';

/** GCC countries and Egypt — day-first dates are the local habit. */
const DAY_FIRST_COUNTRIES: ReadonlySet<string> = new Set([
  'SA',
  'AE',
  'KW',
  'QA',
  'BH',
  'OM',
  'EG',
]);

/**
 * The date format a person most likely reads: the spelled-out `long` form in Arabic (no digit-order
 * ambiguity), day-first `eu` for an English reader in the GCC or Egypt, else `iso`.
 */
export function dateFormatFor(
  locale: string | null | undefined,
  country: string | null | undefined,
): NaturalDateFormat {
  const language = (locale ?? '').trim().toLowerCase().split(/[-_]/)[0];
  if (language === 'ar') return 'long';
  const region = (country ?? '').trim().toUpperCase();
  if (DAY_FIRST_COUNTRIES.has(region)) return 'eu';
  return 'iso';
}

/** The smallest and largest lead, in working days, a due-date suggestion may use. */
export const SUGGESTED_LEAD_MIN = 1;
export const SUGGESTED_LEAD_MAX = 10;

/**
 * The median of the non-negative, finite lead samples (working days between created and due),
 * or `null` when there are none. An even count takes the mean of the two middle values.
 */
export function medianLeadWorkingDays(samples: readonly number[]): number | null {
  const valid = samples.filter((s) => Number.isFinite(s) && s >= 0).sort((a, b) => a - b);
  if (valid.length === 0) return null;
  const mid = Math.floor(valid.length / 2);
  return valid.length % 2 === 1 ? valid[mid]! : (valid[mid - 1]! + valid[mid]!) / 2;
}

export interface DueDateSuggestion {
  /** ISO `YYYY-MM-DD`, always a working day of the calendar. */
  readonly date: string;
  readonly reason: 'next_working_day' | 'project_pace';
}

/**
 * Suggest a due date: `medianLeadWorkingDays` (rounded, clamped to 1..10) working days after
 * `today`, or the next working day when the project has no pace yet. `addWorkingDays` only ever
 * lands on a working day, so the suggestion is never a weekend or holiday.
 */
export function suggestDueDate(input: {
  readonly today: string;
  readonly calendar: WorkingCalendar;
  readonly medianLeadWorkingDays: number | null;
}): DueDateSuggestion {
  const median = input.medianLeadWorkingDays;
  if (median === null || !Number.isFinite(median)) {
    return { date: addWorkingDays(input.today, 1, input.calendar), reason: 'next_working_day' };
  }
  const lead = Math.min(SUGGESTED_LEAD_MAX, Math.max(SUGGESTED_LEAD_MIN, Math.round(median)));
  return { date: addWorkingDays(input.today, lead, input.calendar), reason: 'project_pace' };
}

/** The org-level notification profiles (55-18). `calm` is the default for a new company. */
export const NOTIFICATION_PROFILES = ['calm', 'standard'] as const;
export type NotificationProfile = (typeof NOTIFICATION_PROFILES)[number];
export const DEFAULT_NOTIFICATION_PROFILE: NotificationProfile = 'calm';

/** The notification kinds (mirrors `NOTIFICATION_KINDS` in the API schema). */
export type NaturalNotificationKind =
  'client_request' | 'work_item' | 'message' | 'file' | 'mention';
const ALL_KINDS: readonly NaturalNotificationKind[] = [
  'client_request',
  'work_item',
  'message',
  'file',
  'mention',
];

/** Kinds that ask the person to act. They are never batched into a digest, whatever the profile. */
const REQUIRED_ACTION_KINDS: ReadonlySet<string> = new Set([
  'client_request',
  'mention',
  'work_item',
]);

export function isRequiredActionKind(kind: string): boolean {
  return REQUIRED_ACTION_KINDS.has(kind);
}

export function isNotificationProfile(value: unknown): value is NotificationProfile {
  return typeof value === 'string' && (NOTIFICATION_PROFILES as readonly string[]).includes(value);
}

export interface NotificationProfileDefaults {
  readonly digestFrequency: 'off' | 'daily' | 'weekly';
  /** `HH:MM:SS` wall clock, or null for no quiet hours. */
  readonly quietHoursStart: string | null;
  readonly quietHoursEnd: string | null;
  readonly immediateKinds: readonly NaturalNotificationKind[];
  readonly digestKinds: readonly NaturalNotificationKind[];
}

/**
 * What a member with no saved settings starts with. `calm`: a daily digest, quiet 19:00–08:00, only
 * the required-action kinds immediately. `standard`: the pre-55-18 defaults (everything immediate,
 * no digest, no quiet hours). A required-action kind is never in `digestKinds`.
 */
export function notificationDefaultsFor(profile: NotificationProfile): NotificationProfileDefaults {
  if (profile === 'calm') {
    return {
      digestFrequency: 'daily',
      quietHoursStart: '19:00:00',
      quietHoursEnd: '08:00:00',
      immediateKinds: ['client_request', 'mention', 'work_item'],
      digestKinds: ['message', 'file'],
    };
  }
  return {
    digestFrequency: 'off',
    quietHoursStart: null,
    quietHoursEnd: null,
    immediateKinds: [...ALL_KINDS],
    digestKinds: [],
  };
}

/** How an unset kind is delivered under `profile`: immediately, or batched into the digest. */
export function kindDeliveryFor(
  profile: NotificationProfile,
  kind: string,
): 'immediate' | 'digest' {
  if (isRequiredActionKind(kind)) return 'immediate';
  return (notificationDefaultsFor(profile).digestKinds as readonly string[]).includes(kind)
    ? 'digest'
    : 'immediate';
}

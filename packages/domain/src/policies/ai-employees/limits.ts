/**
 * 60-01 (plan 60 v2 §4.9). The limits of one AI employee and its working hours, as data.
 *
 * "Defaults; the owner may lower them, raise only up to the platform cap." In the beta the cap
 * equals the default for every limit except revision rounds (default 3, at most 6), so an owner
 * can only tighten. Stored in `ai_employees.limits_json` and `working_hours_json` (LONGTEXT read
 * here, IP-2); an unreadable stored value reads as the defaults, never as "no limit".
 *
 * Pure: no I/O. The clock is a parameter ({@link isWithinWorkingHours}).
 */

export interface AiEmployeeLimits {
  readonly callsPerMinute: number;
  readonly writesPerDay: number;
  readonly openAssignments: number;
  readonly questionRounds: number;
  readonly questionsPerRound: number;
  readonly attemptsPerRound: number;
  readonly revisionRounds: number;
}

export type AiEmployeeLimitKey = keyof AiEmployeeLimits;

export const AI_EMPLOYEE_LIMIT_DEFAULTS: AiEmployeeLimits = Object.freeze({
  callsPerMinute: 60,
  writesPerDay: 600,
  openAssignments: 20,
  questionRounds: 2,
  questionsPerRound: 7,
  attemptsPerRound: 3,
  revisionRounds: 3,
});

/** The platform cap of each limit (beta). Never below the default. */
export const AI_EMPLOYEE_LIMIT_CAPS: AiEmployeeLimits = Object.freeze({
  ...AI_EMPLOYEE_LIMIT_DEFAULTS,
  revisionRounds: 6,
});

const LIMIT_KEYS = Object.keys(AI_EMPLOYEE_LIMIT_DEFAULTS) as AiEmployeeLimitKey[];

/** AI employees per workspace in the beta (open question 1; a platform setting later). */
export const AI_EMPLOYEES_PER_WORKSPACE = 5;

/** Live credentials per AI employee (§4.5). */
export const AI_EMPLOYEE_MAX_LIVE_CREDENTIALS = 3;

/** Agent key lifetimes an owner may pick (§4.5, §4.9). */
export const AI_AGENT_KEY_LIFETIME_DAYS = [30, 60, 90] as const;

export type AiLimitsParse =
  | { readonly ok: true; readonly limits: AiEmployeeLimits }
  | {
      readonly ok: false;
      /** The first field that is not a whole number from 1 to its cap, or not a limit at all. */
      readonly field: string;
      readonly reason: 'unknown_field' | 'not_a_whole_number' | 'above_cap' | 'below_one';
    };

/**
 * Parse an owner's limits patch (a JSON object of some limit keys). Absent keys keep the defaults.
 * A value above the platform cap is refused, not clamped, so the owner sees why.
 */
export function parseAiEmployeeLimits(input: unknown): AiLimitsParse {
  if (input === null || input === undefined)
    return { ok: true, limits: AI_EMPLOYEE_LIMIT_DEFAULTS };
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, field: '', reason: 'unknown_field' };
  }
  const out: Record<AiEmployeeLimitKey, number> = { ...AI_EMPLOYEE_LIMIT_DEFAULTS };
  for (const [field, value] of Object.entries(input)) {
    const key = LIMIT_KEYS.find((candidate) => candidate === field);
    if (key === undefined) return { ok: false, field, reason: 'unknown_field' };
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      return { ok: false, field, reason: 'not_a_whole_number' };
    }
    if (value < 1) return { ok: false, field, reason: 'below_one' };
    if (value > AI_EMPLOYEE_LIMIT_CAPS[key]) return { ok: false, field, reason: 'above_cap' };
    out[key] = value;
  }
  return { ok: true, limits: Object.freeze(out) };
}

/** Read a stored `limits_json`. Anything unreadable is the defaults (never "unlimited"). */
export function readStoredAiEmployeeLimits(stored: string | null): AiEmployeeLimits {
  if (stored === null || stored.trim() === '') return AI_EMPLOYEE_LIMIT_DEFAULTS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return AI_EMPLOYEE_LIMIT_DEFAULTS;
  }
  const result = parseAiEmployeeLimits(parsed);
  return result.ok ? result.limits : AI_EMPLOYEE_LIMIT_DEFAULTS;
}

// ---- Working hours ----

/** ISO weekday: 1 = Monday … 7 = Sunday. */
export type IsoWeekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface WorkingWindow {
  readonly day: IsoWeekday;
  /** Minutes from local midnight, inclusive. */
  readonly startMinute: number;
  /** Minutes from local midnight, exclusive; greater than `startMinute` (no overnight window). */
  readonly endMinute: number;
}

/**
 * When an AI employee works, in its IANA time zone. `null` windows = always (the default: most
 * agents run on demand). Used for the "not picked up in 15 minutes inside working hours" rule.
 */
export interface WorkingHours {
  readonly timezone: string;
  readonly windows: readonly WorkingWindow[] | null;
}

export const MAX_WORKING_WINDOWS = 21;

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

function minuteOf(value: unknown, allowMidnightEnd: boolean): number | null {
  if (allowMidnightEnd && value === '24:00') return 1440;
  if (typeof value !== 'string') return null;
  const match = HHMM.exec(value);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/** Is this an IANA time zone this runtime knows? */
export function isKnownTimeZone(timezone: string): boolean {
  if (timezone.trim() === '' || timezone.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

export type WorkingHoursParse =
  | { readonly ok: true; readonly hours: WorkingHours }
  | { readonly ok: false; readonly reason: 'timezone' | 'windows' };

/**
 * Parse `{ timezone, windows: [{ day: 1..7, start: 'HH:MM', end: 'HH:MM' | '24:00' }] | null }`.
 */
export function parseWorkingHours(input: unknown): WorkingHoursParse {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, reason: 'timezone' };
  }
  const record = input as Readonly<Record<string, unknown>>;
  const timezone = record['timezone'];
  if (typeof timezone !== 'string' || !isKnownTimeZone(timezone)) {
    return { ok: false, reason: 'timezone' };
  }
  const rawWindows = record['windows'];
  if (rawWindows === null || rawWindows === undefined) {
    return { ok: true, hours: { timezone, windows: null } };
  }
  if (!Array.isArray(rawWindows) || rawWindows.length === 0)
    return { ok: false, reason: 'windows' };
  if (rawWindows.length > MAX_WORKING_WINDOWS) return { ok: false, reason: 'windows' };
  const windows: WorkingWindow[] = [];
  for (const raw of rawWindows as readonly unknown[]) {
    if (typeof raw !== 'object' || raw === null) return { ok: false, reason: 'windows' };
    const entry = raw as Readonly<Record<string, unknown>>;
    const day = entry['day'];
    if (day !== 1 && day !== 2 && day !== 3 && day !== 4 && day !== 5 && day !== 6 && day !== 7) {
      return { ok: false, reason: 'windows' };
    }
    const startMinute = minuteOf(entry['start'], false);
    const endMinute = minuteOf(entry['end'], true);
    if (startMinute === null || endMinute === null || endMinute <= startMinute) {
      return { ok: false, reason: 'windows' };
    }
    windows.push(Object.freeze({ day, startMinute, endMinute }));
  }
  return { ok: true, hours: Object.freeze({ timezone, windows: Object.freeze(windows) }) };
}

const WEEKDAY: Readonly<Record<string, IsoWeekday>> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};

/** Is `at` inside the working hours? Always true when no windows are set. */
export function isWithinWorkingHours(hours: WorkingHours, at: Date): boolean {
  if (hours.windows === null) return true;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: hours.timezone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value ?? '';
  const day = WEEKDAY[part('weekday')];
  if (day === undefined) return false;
  const minute = Number(part('hour')) * 60 + Number(part('minute'));
  return hours.windows.some(
    (window) => window.day === day && minute >= window.startMinute && minute < window.endMinute,
  );
}

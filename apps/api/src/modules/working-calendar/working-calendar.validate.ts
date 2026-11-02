import {
  MAX_HOLIDAY_LABEL_LENGTH,
  hasWorkingDay,
  holidayPack,
  isIsoDate,
  isValidTimeZone,
  isWithinHorizon,
  maskOfWeekdays,
  minutesOfClock,
} from '@tmanage/domain';
import type { HolidayPack } from '@tmanage/domain';
import { ApiError } from '../../common/http/errors.js';
import type { ApiErrorDetail } from '../../common/http/errors.js';

/**
 * 53-02 — request validation for the working calendar. Every refusal is a 400 naming the field;
 * the reason rides in `details` (`ApiErrorCode` is a closed list).
 *
 * - Working days: an array of weekday numbers (0 = Sunday … 6 = Saturday), at least one.
 * - Hours: `HH:MM`, start before end. Time zone: a known IANA zone (≤ 64 chars).
 * - Holidays: ISO date within ±5 years of today; English label 1–80 chars, Arabic optional; no
 *   markup (`<`, `>`) and no control characters.
 */

export interface CalendarInput {
  readonly workingDaysMask: number;
  readonly dayStart: string;
  readonly dayEnd: string;
  readonly timeZone: string;
  /** The version the editor last read; 0 when no calendar row existed. */
  readonly version: number;
}

export interface HolidayInput {
  readonly date: string;
  readonly labelEn: string;
  readonly labelAr: string | null;
}

export function invalid(field: string, message: string): ApiError {
  return invalidAll([{ field, message }]);
}

function invalidAll(details: readonly ApiErrorDetail[]): ApiError {
  return new ApiError(400, 'validation_failed', 'The request body is invalid', details);
}

export function record(body: unknown): Record<string, unknown> {
  return typeof body === 'object' && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

function clock(value: unknown, field: string): string {
  if (typeof value !== 'string' || minutesOfClock(value) === null || value.length !== 5) {
    throw invalid(field, 'must be HH:MM');
  }
  return value;
}

export function parseCalendarInput(body: unknown): CalendarInput {
  const input = record(body);
  const days = input['workingDays'];
  if (
    !Array.isArray(days) ||
    days.length > 7 ||
    !days.every((day) => Number.isInteger(day) && (day as number) >= 0 && (day as number) <= 6)
  ) {
    throw invalid('workingDays', 'must be a list of weekday numbers 0–6');
  }
  const workingDaysMask = maskOfWeekdays(days as number[]);
  if (!hasWorkingDay(workingDaysMask)) {
    throw invalid('workingDays', 'working_calendar_no_working_day');
  }
  const dayStart = clock(input['dayStart'], 'dayStart');
  const dayEnd = clock(input['dayEnd'], 'dayEnd');
  if ((minutesOfClock(dayStart) ?? 0) >= (minutesOfClock(dayEnd) ?? 0)) {
    throw invalid('dayEnd', 'must be after dayStart');
  }
  const timeZone = input['timeZone'];
  if (typeof timeZone !== 'string' || timeZone.length > 64 || !isValidTimeZone(timeZone)) {
    throw invalid('timeZone', 'must be a known IANA time zone');
  }
  const version = input['version'];
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) {
    throw invalid('version', 'must be the version you last read');
  }
  return { workingDaysMask, dayStart, dayEnd, timeZone, version };
}

function hasMarkupOrControl(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (char === '<' || char === '>' || code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

export function label(value: unknown, field: string, required: boolean): string | null {
  if (value === undefined || value === null || value === '') {
    if (required) throw invalid(field, 'is required');
    return null;
  }
  if (typeof value !== 'string') throw invalid(field, 'must be a string');
  const trimmed = value.trim();
  if (trimmed === '') {
    if (required) throw invalid(field, 'is required');
    return null;
  }
  if (trimmed.length > MAX_HOLIDAY_LABEL_LENGTH) {
    throw invalid(field, `must be at most ${String(MAX_HOLIDAY_LABEL_LENGTH)} characters`);
  }
  if (hasMarkupOrControl(trimmed)) throw invalid(field, 'must not contain markup');
  return trimmed;
}

/** A holiday date: strict ISO, within ±5 years of `today`. */
export function holidayDate(value: unknown, today: string, field = 'date'): string {
  if (!isIsoDate(value)) throw invalid(field, 'must be an ISO date (YYYY-MM-DD)');
  if (!isWithinHorizon(value, today)) throw invalid(field, 'must be within 5 years of today');
  return value;
}

export function parseHolidayInput(body: unknown, today: string): HolidayInput {
  const input = record(body);
  return {
    date: holidayDate(input['date'], today),
    labelEn: label(input['labelEn'], 'labelEn', true) as string,
    labelAr: label(input['labelAr'], 'labelAr', false),
  };
}

export function parsePackKey(body: unknown): HolidayPack {
  const key = record(body)['packKey'];
  const pack = typeof key === 'string' && key.length <= 32 ? holidayPack(key) : null;
  if (pack === null) throw invalid('packKey', 'must name a shipped holiday pack');
  return pack;
}

import { withNumerals } from '../../lib/i18n/display-format';
import { pluralPhrase } from '../../lib/i18n/plural';
import { dayOffset } from './my-day-model';
import { appDateLocale } from '../../lib/i18n/app-locale';

/**
 * **My Day v3.1 words for times and dates.** Pure helpers that turn the API's ISO strings into the
 * short labels the widgets show ("Due Tue", "3 days late", "for 2 days", "3 h 20 min"). Arabic
 * keeps Latin digits, as every Arabic frame writes them (I18N-03).
 */

type TOr = (key: string, english: string) => string;

function isArabic(locale: string): boolean {
  return locale.toLowerCase().startsWith('ar');
}

/** The tag dates use: Arabic, else en-GB; digits by the app rule (Latin unless chosen). */
export function dateTag(locale: string): string {
  return appDateLocale(isArabic(locale) ? locale : 'en-GB');
}

/** "3 days late" (Figma late chip), from the whole days an item is overdue. */
/** Latin digits like every other number on the page (823:1312, 824:322), unless the person chose others. */
function digits(count: number): string {
  return count.toLocaleString(withNumerals('en-GB'));
}

export function lateLabel(tr: TOr, locale: string, days: number): string {
  return pluralPhrase(
    tr,
    locale,
    'MyDay.late',
    days,
    { one: '1 day late', other: '{count} days late' },
    digits(days),
  );
}

/**
 * The due chip of a row that is not late: "Due today", the weekday within the next six days
 * ("Due Tue", Fable F9), then the day and month ("Due 4 Dec").
 */
export function dueLabel(tr: TOr, locale: string, dueAt: string | null, now: number): string {
  if (dueAt === null) return tr('MyDay.noDueDate', 'No due date');
  const offset = dayOffset(dueAt, now);
  if (offset === null) return tr('MyDay.noDueDate', 'No due date');
  if (offset <= 0) return tr('MyDay.dueToday', 'Due today');
  return tr('MyDay.dueOn', 'Due {day}').replace('{day}', shortDate(locale, dueAt, offset < 7));
}

/** "Tue" within the week, else "4 Dec". */
export function shortDate(locale: string, iso: string, weekday: boolean): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(
    dateTag(locale),
    weekday ? { weekday: 'short' } : { day: 'numeric', month: 'short' },
  );
}

/** The summary line's date: "Sun 22 Nov". */
export function dayLine(locale: string, now: number): string {
  return new Date(now)
    .toLocaleDateString(dateTag(locale), { weekday: 'short', day: 'numeric', month: 'short' })
    .replace(',', '');
}

/** "11:24", 24-hour, Latin digits. */
export function clock(iso: string | number): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString(withNumerals('en-GB'), {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/** "for 2 days", "for 3 h" (Fable F14): how long something has waited. */
export function waitedFor(tr: TOr, locale: string, since: string, now: number): string {
  const start = Date.parse(since);
  if (Number.isNaN(start)) return '';
  const hours = Math.max(1, Math.floor((now - start) / 3_600_000));
  if (hours < 24) return tr('MyDay.forHours', 'for {count} h').replace('{count}', String(hours));
  const days = Math.floor(hours / 24);
  return pluralPhrase(
    tr,
    locale,
    'MyDay.forDays',
    days,
    { one: 'for 1 day', other: 'for {count} days' },
    digits(days),
  );
}

/** "3 h 20 min", or "20 min" under an hour. */
export function duration(tr: TOr, minutes: number): string {
  const whole = Math.max(0, Math.round(minutes));
  const h = Math.floor(whole / 60);
  const m = whole % 60;
  if (h === 0) return tr('MyDay.minutes', '{m} min').replace('{m}', String(m));
  return tr('MyDay.hoursMinutes', '{h} h {m} min')
    .replace('{h}', String(h))
    .replace('{m}', String(m));
}

/** "00:42": the running timer's hours and minutes, as the title-row capsule and Timer show it. */
export function elapsedFace(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const two = (n: number) => String(n).padStart(2, '0');
  return `${two(Math.floor(whole / 3600))}:${two(Math.floor((whole % 3600) / 60))}`;
}

/** Today's local date as the timesheet writes it (`spentOn`, YYYY-MM-DD). */
export function localDay(now: number): string {
  const date = new Date(now);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
}

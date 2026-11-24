import { withNumerals } from './display-format';

/**
 * Live check item 10 — a duration in minutes, in the reader's language: "5h 30m" in English,
 * "5 ساعات و30 دقيقة" in Arabic (no Latin "m", the right plural), "5 Std. 30 Min." in German.
 * Arabic uses the long unit names (the short ones are single letters); the rest use the narrow
 * ones so table columns stay short.
 */
export function formatDuration(totalMinutes: number, locale: string): string {
  const total = Math.max(0, Math.round(totalMinutes));
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  const arabic = locale.toLowerCase().startsWith('ar');
  const unitDisplay = arabic ? 'long' : 'narrow';
  const tag = withNumerals(locale);
  const part = (value: number, unit: 'hour' | 'minute') =>
    new Intl.NumberFormat(tag, { style: 'unit', unit, unitDisplay }).format(value);
  if (hours === 0) return part(minutes, 'minute');
  if (minutes === 0) return part(hours, 'hour');
  return arabic
    ? `${part(hours, 'hour')} و${part(minutes, 'minute')}`
    : `${part(hours, 'hour')} ${part(minutes, 'minute')}`;
}

/**
 * WX3 (review R2) — a duration for a narrow value column (the work page's Time row, Figma
 * `WV2-02` AR "3 س 20 د من 6 س"): Arabic writes the units as the one-letter abbreviations س and
 * د (hour, minute) after the number; every other language keeps {@link formatDuration}, whose
 * narrow units are already short. Callers show the long form too, as the row's accessible name
 * and its hover text, because a one-letter unit alone is easy to misread.
 */
export function formatDurationCompact(totalMinutes: number, locale: string): string {
  if (!locale.toLowerCase().startsWith('ar')) return formatDuration(totalMinutes, locale);
  const total = Math.max(0, Math.round(totalMinutes));
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  const number = new Intl.NumberFormat(withNumerals(locale));
  const hour = `${number.format(hours)} س`;
  const minute = `${number.format(minutes)} د`;
  if (hours === 0) return minute;
  if (minutes === 0) return hour;
  return `${hour} ${minute}`;
}

/**
 * SMALLFIX 1 — a fixed window in plain words: "24 hours", "٢٤ ساعة", "2 days", "15 minutes".
 * The largest whole unit (days from two days up, so a day-long window still reads "24 hours"),
 * spelled out (long unit names), in the reader's language and saved digits.
 */
export function formatWholeDuration(totalMinutes: number, locale: string): string {
  const total = Math.max(0, Math.round(totalMinutes));
  const tag = withNumerals(locale);
  const part = (value: number, unit: 'day' | 'hour' | 'minute') =>
    new Intl.NumberFormat(tag, { style: 'unit', unit, unitDisplay: 'long' }).format(value);
  if (total >= 2 * 1440 && total % 1440 === 0) return part(total / 1440, 'day');
  if (total >= 60 && total % 60 === 0) return part(total / 60, 'hour');
  return part(total, 'minute');
}

/** Arabic names of the time zones companies here use most; elsewhere the city of the IANA id. */
const ARABIC_CITY: Readonly<Record<string, string>> = {
  'Africa/Cairo': 'القاهرة',
  'Asia/Riyadh': 'الرياض',
  'Asia/Dubai': 'دبي',
  'Asia/Kuwait': 'الكويت',
  'Asia/Qatar': 'الدوحة',
  'Asia/Bahrain': 'البحرين',
  'Asia/Muscat': 'مسقط',
  'Asia/Amman': 'عمّان',
  'Asia/Beirut': 'بيروت',
  'Asia/Baghdad': 'بغداد',
  'Africa/Casablanca': 'الدار البيضاء',
  'Africa/Tunis': 'تونس',
  'Africa/Algiers': 'الجزائر',
  'Africa/Tripoli': 'طرابلس',
  'Africa/Khartoum': 'الخرطوم',
  'Europe/London': 'لندن',
  'Europe/Berlin': 'برلين',
  'Europe/Paris': 'باريس',
  'America/New_York': 'نيويورك',
  UTC: 'التوقيت العالمي',
};

/** Item 10: a time zone by a readable name ("Cairo", "القاهرة"), never the raw IANA id. */
export function timeZoneCity(zone: string, locale: string): string {
  if (locale.toLowerCase().startsWith('ar')) {
    const city = ARABIC_CITY[zone];
    if (city !== undefined) return city;
  }
  if (zone === 'UTC') return 'UTC';
  const last = zone.split('/').at(-1) ?? zone;
  return last.replace(/_/gu, ' ');
}

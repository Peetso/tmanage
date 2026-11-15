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

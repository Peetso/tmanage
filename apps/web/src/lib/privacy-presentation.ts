import { appDateLocale } from './i18n/app-locale';

/**
 * D5 (Figma F5) — how the Privacy pages word dates, sizes and states. Pure, so a unit proves the
 * frame's readings ("1 Nov 2026", "today at 13:05", "2.4 GB", "About 40% done") without a render.
 */

/** Replace each `{slot}` in a catalog string. */
export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/gu, (whole, slot: string) =>
    slot in values ? String(values[slot]) : whole,
  );
}

function isArabic(locale: string): boolean {
  return locale.toLowerCase().startsWith('ar');
}

/**
 * The frame's calendar day: "1 Nov 2026" in English, "1 نوفمبر 2026" in Arabic (Latin digits, as the
 * Arabic frame writes them). Unparseable input is returned verbatim.
 */
export function privacyDay(iso: string, locale: string, timeZone?: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const arabic = isArabic(locale);
  return new Intl.DateTimeFormat(appDateLocale(locale), {
    day: 'numeric',
    month: arabic ? 'long' : 'short',
    year: 'numeric',
    ...(timeZone ? { timeZone } : {}),
  }).format(at);
}

/** The frame's clock reading, 24-hour: "13:05". */
export function privacyClock(iso: string, timeZone?: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    ...(timeZone ? { timeZone } : {}),
  }).format(at);
}

/** Does the instant fall on the same calendar day as `now`, read in the same zone? */
export function isSameDay(iso: string, now: Date, timeZone?: string): boolean {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return false;
  const day = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    ...(timeZone ? { timeZone } : {}),
  });
  return day.format(at) === day.format(now);
}

/** "2.4 GB", "120 MB", "18 KB": decimal units, one decimal place only from GB up. */
export function privacySize(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes >= 1e9) return `${(Math.round(bytes / 1e8) / 10).toString()} GB`;
  if (bytes >= 1e6) return `${Math.max(1, Math.round(bytes / 1e6)).toString()} MB`;
  if (bytes >= 1e3) return `${Math.round(bytes / 1e3).toString()} KB`;
  return `${bytes.toString()} B`;
}

/** The progress bar's width, clamped to a sensible minimum so a started export always shows. */
export function progressShare(percent: number): number {
  if (!Number.isFinite(percent)) return 0;
  return Math.min(100, Math.max(4, Math.round(percent)));
}

/** "Maya Hassan" → "MH". */
export function initialsOf(name: string): string {
  return name
    .trim()
    .split(/\s+/u)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('');
}

/** "Sara Ali" → "Sara". */
export function firstNameOf(name: string): string {
  return name.trim().split(/\s+/u)[0] ?? name;
}

/** The typed confirmation the delete dialog asks for: exact, ignoring outer spaces only. */
export function confirmsName(typed: string, organizationName: string): boolean {
  return typed.trim() === organizationName.trim() && organizationName.trim() !== '';
}

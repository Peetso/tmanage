import type { MessageKey } from './i18n/t';
import { appDateLocale } from './i18n/app-locale';

/**
 * Pure presentation for the Connected apps page (S0-2, MCP connector S11): the app monograms,
 * the scope chip labels, and the "Connected …" / "Last used …" wording. Kept out of the component
 * so each rule is provable without a render.
 */

/**
 * One short monogram per app, unique on the page, as the design draws them: the first letter
 * ("Claude" → C); if that is taken, the next capital in the name ("ChatGPT" → G); otherwise the
 * first two letters ("Cursor" → Cu).
 */
export function appMonograms(names: readonly string[]): string[] {
  const used = new Set<string>();
  return names.map((name) => {
    const trimmed = name.trim();
    const first = (trimmed.charAt(0) || '?').toUpperCase();
    const candidates = [
      first,
      ...[...trimmed.slice(1)].filter((char) => char >= 'A' && char <= 'Z'),
      first + trimmed.charAt(1).toLowerCase(),
    ];
    const pick = candidates.find((candidate) => candidate.trim() !== '' && !used.has(candidate));
    const monogram = pick ?? first;
    used.add(monogram);
    return monogram;
  });
}

const SCOPE_LABELS: Readonly<Record<string, MessageKey>> = {
  'tmanage:read': 'ConnectedApps.scopeRead',
  'tmanage:write': 'ConnectedApps.scopeWrite',
  'tmanage:manage': 'ConnectedApps.scopeManage',
  'tmanage:billing': 'ConnectedApps.scopeBilling',
};

/** The catalog key for a scope chip; `undefined` for a scope the page cannot explain (not drawn). */
export function scopeLabelKey(scope: string): MessageKey | undefined {
  return SCOPE_LABELS[scope];
}

/** "12 Jul 2026" (English), "12 يوليو 2026" (Arabic). */
export function formatConnectedDate(iso: string, locale: string): string {
  const arabic = locale.toLowerCase().startsWith('ar');
  return new Intl.DateTimeFormat(appDateLocale(locale), {
    day: 'numeric',
    month: arabic ? 'long' : 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(iso));
}

const UNITS: readonly [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 60 * 60],
  ['month', 30 * 24 * 60 * 60],
  ['week', 7 * 24 * 60 * 60],
  ['day', 24 * 60 * 60],
  ['hour', 60 * 60],
  ['minute', 60],
];

/** "2 minutes ago", "yesterday", "4 days ago" — and the Arabic equivalents — or "now" wording. */
export function formatLastUsed(iso: string, now: Date, locale: string): string {
  const seconds = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 1000));
  const format = new Intl.RelativeTimeFormat(appDateLocale(locale, locale), { numeric: 'auto' });
  for (const [unit, size] of UNITS) {
    if (seconds >= size) return format.format(-Math.floor(seconds / size), unit);
  }
  return format.format(0, 'minute');
}

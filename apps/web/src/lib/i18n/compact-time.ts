import { shapeDigits, withNumerals } from './display-format';
import { activeLocale } from './locale-store';
import { translate, type MessageKey } from './t';

/**
 * Small, locale-aware time words for the compact columns (2026-10-31 Arabic live test).
 *
 * Several lists print an age as `14m`, `3h`, `2d` and a last-activity line as `18 min ago`. Those
 * were hand-built English strings, so an Arabic member read English units in an otherwise Arabic
 * screen. English keeps exactly the strings it always had (the frames and the tests read them);
 * every other locale gets the platform's own narrow unit (`١٤ د`) or relative phrase
 * (`قبل ١٨ دقيقة`) from `Intl`, which already knows Arabic plurals.
 */

export type CompactUnit = 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year';

const EN_SUFFIX: Record<CompactUnit, string> = {
  minute: 'm',
  hour: 'h',
  day: 'd',
  week: 'w',
  month: 'mo',
  year: 'y',
};

function isEnglish(locale: string): boolean {
  return locale.toLowerCase().startsWith('en');
}

/** `14m` in English, `14 دقيقة` in Arabic — one compact age cell. */
export function compactUnit(
  value: number,
  unit: CompactUnit,
  locale: string = activeLocale.get(),
): string {
  if (isEnglish(locale)) return shapeDigits(`${value}${EN_SUFFIX[unit]}`);
  try {
    // FIX5 item 6b (B-N7): the saved digit shapes, not the locale's default ones. Arabic and Urdu
    // narrow units are a single letter ("8 د", "7 ي") that readers could not decode, so those two
    // spell the unit out ("8 دقائق", "7 أيام", "دقيقة"), which Intl also inflects for the count.
    const spelled = /^(ar|ur)(-|$)/iu.test(locale);
    return new Intl.NumberFormat(withNumerals(locale), {
      style: 'unit',
      unit,
      unitDisplay: spelled ? 'long' : 'narrow',
    }).format(value);
  } catch {
    return `${value}${EN_SUFFIX[unit]}`;
  }
}

/** `قبل ١٨ دقيقة` — a relative phrase in the active (non-English) locale. */
export function relativeAgo(
  value: number,
  unit: CompactUnit,
  locale: string = activeLocale.get(),
): string {
  try {
    return new Intl.RelativeTimeFormat(withNumerals(locale), { numeric: 'always' }).format(
      -value,
      unit,
    );
  } catch {
    return `${value} ${unit}`;
  }
}

/** Whether the active locale is English — the callers keep their own English wording then. */
export function activeIsEnglish(locale: string = activeLocale.get()): boolean {
  return isEnglish(locale);
}

/**
 * `translate` for a key that may not have reached the catalogs yet (it arrives through an i18n
 * fragment the committer merges). Returns the English text until the key exists, never the raw key.
 */
export function translateOr(
  key: string,
  english: string,
  locale: string = activeLocale.get(),
): string {
  const value = translate(locale, key as MessageKey);
  return value === key ? english : value;
}

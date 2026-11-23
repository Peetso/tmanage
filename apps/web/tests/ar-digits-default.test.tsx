import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { count } from '../src/components/billing/plan-usage-format';
import { tagFor } from '../src/components/docs/doc-markdown';
import { dateTag } from '../src/components/my-day/my-day-format';
import { usd } from '../src/components/platform/ai-spend/ai-spend-model';
import { shortDay } from '../src/components/projects/EditMilestoneDialog';
import { formatUpdateDay } from '../src/components/projects/UnpublishUpdateDialog';
import { formatConnectedDate } from '../src/lib/connected-apps-presentation';
import { appDateLocale, appIntlLocale } from '../src/lib/i18n/app-locale';
import { displayFormat, withNumerals } from '../src/lib/i18n/display-format';
import { formatDay, formatNumber, formatTime } from '../src/lib/i18n/format';
import { activeLocale, DEFAULT_LOCALE } from '../src/lib/i18n/locale-store';
import { privacyDay } from '../src/lib/privacy-presentation';

/**
 * AR-DIGITS (manager decision 2026-11-23): every Figma frame, Arabic included, writes Latin digits,
 * so the app's default is Latin digits in every locale. A member who chose Arabic-Indic digits in
 * Settings › Display keeps them. The rule lives once, in `withNumerals` (display-format.ts), and
 * `appDateLocale` / `appIntlLocale` / the shared formatters all go through it.
 */
const ARABIC_INDIC = /[٠-٩]/u;
const PERSIAN = /[۰-۹]/u;
const ARABIC_LETTERS = /[ء-ي]/u;
const AT = '2026-11-22T09:42:00.000Z';

afterEach(() => {
  displayFormat.set({});
  activeLocale.set(DEFAULT_LOCALE);
});

describe('the default is Latin digits', () => {
  it('adds -u-nu-latn only where the locale would otherwise draw other digits', () => {
    expect(withNumerals('ar-EG')).toBe('ar-EG-u-nu-latn');
    expect(withNumerals('fa-IR')).toBe('fa-IR-u-nu-latn');
    expect(withNumerals('ar-EG-u-ca-islamic')).toBe('ar-EG-u-nu-latn-ca-islamic');
    // Already Latin by CLDR default: the tag is left exactly as it was.
    expect(withNumerals('en-GB')).toBe('en-GB');
    expect(withNumerals('en-US')).toBe('en-US');
    expect(withNumerals('ur-PK')).toBe('ur-PK');
    expect(withNumerals('de-DE')).toBe('de-DE');
  });

  it('keeps a digit system the caller named on the tag', () => {
    expect(withNumerals('ar-EG-u-nu-arab')).toBe('ar-EG-u-nu-arab');
  });

  it('writes Arabic dates, times and counts with Latin digits and Arabic words', () => {
    const ctx = { locale: 'ar-EG', timeZone: 'UTC' };
    expect(formatNumber(1240, ctx)).not.toMatch(ARABIC_INDIC);
    expect(formatNumber(8, ctx)).toBe('8');
    const day = formatDay(AT, ctx, { day: 'numeric', month: 'long', timeZone: 'UTC' });
    expect(day).toMatch(/^22 /u);
    expect(day).toMatch(ARABIC_LETTERS);
    expect(formatTime(AT, ctx)).not.toMatch(ARABIC_INDIC);
    const persian = new Intl.NumberFormat(withNumerals('fa-IR')).format(1240);
    expect(persian).not.toMatch(PERSIAN);
  });

  it('appDateLocale and appIntlLocale follow it, English keeps its approved shape', () => {
    expect(appDateLocale('ar-EG')).toBe('ar-EG-u-nu-latn');
    expect(appDateLocale('en-US')).toBe('en-GB');
    expect(appDateLocale('en-US', 'en-US')).toBe('en-US');
    activeLocale.set('ar-EG');
    expect(new Intl.NumberFormat(appIntlLocale()).format(333)).toBe('333');
    activeLocale.set('en-US');
    expect(appIntlLocale()).toBe('en-US');
  });
});

describe('a saved choice wins over the default', () => {
  it('Arabic-Indic digits when the member chose them', () => {
    displayFormat.set({ numerals: 'arabic_indic' });
    expect(withNumerals('ar-EG')).toBe('ar-EG-u-nu-arab');
    expect(appDateLocale('ar-EG')).toBe('ar-EG-u-nu-arab');
    expect(formatNumber(8, { locale: 'ar-EG' })).toBe('٨');
    activeLocale.set('ar-EG');
    expect(new Intl.NumberFormat(appIntlLocale()).format(8)).toBe('٨');
  });

  it('saved Latin is the same as the default', () => {
    displayFormat.set({ numerals: 'latin' });
    expect(withNumerals('ar-EG')).toBe('ar-EG-u-nu-latn');
    expect(formatNumber(8, { locale: 'ar-EG' })).toBe('8');
  });
});

describe('the screens that used to write -u-nu-latn by hand', () => {
  /** Each former workaround, Arabic then English, as the screen calls it. */
  const screens: readonly (readonly [string, (locale: string) => string])[] = [
    [
      'docs tagFor',
      (l) => new Intl.DateTimeFormat(tagFor(l), { day: 'numeric' }).format(new Date(AT)),
    ],
    [
      'My Day dateTag',
      (l) => new Date(AT).toLocaleDateString(dateTag(l), { day: 'numeric', month: 'short' }),
    ],
    ['AI spend usd', (l) => usd(412_500_000, l)],
    ['plan usage count', (l) => count(1240, l)],
    ['milestone shortDay', (l) => shortDay('2026-11-14', l)],
    ['update day', (l) => formatUpdateDay('2026-10-21', l, true)],
    ['connected apps date', (l) => formatConnectedDate('2026-07-12T10:00:00.000Z', l)],
    ['privacy day', (l) => privacyDay('2026-11-01T10:00:00.000Z', l, 'UTC')],
  ];

  it.each(screens)('%s: Latin digits in Arabic by default, unchanged in English', (_name, run) => {
    const ar = run('ar-EG');
    expect(ar).toMatch(/[0-9]/u);
    expect(ar).not.toMatch(ARABIC_INDIC);
    expect(run('en-US')).not.toMatch(ARABIC_INDIC);
  });

  it.each(screens)('%s: the saved Arabic-Indic choice now reaches it', (_name, run) => {
    displayFormat.set({ numerals: 'arabic_indic' });
    expect(run('ar-EG')).toMatch(ARABIC_INDIC);
  });

  it('keeps the exact English and Arabic text the frames show', () => {
    expect(shortDay('2026-11-13', 'en-US')).toBe('Fri 13 Nov');
    expect(shortDay('2026-11-13', 'ar-EG')).toBe('الجمعة 13 نوفمبر');
    expect(formatUpdateDay('2026-10-21', 'en-US', true)).toBe('Wed 21 Oct');
    expect(usd(412_000_000, 'en-US')).toBe('$412');
    expect(count(1240, 'en-US')).toBe('1,240');
  });
});

describe('fitness: no screen picks its own digit system (AR-DIGITS)', () => {
  const SRC = join(dirname(fileURLToPath(import.meta.url)), '../src');
  /** Where a digit system may be named: the rule itself, and fixed build-time marketing copy. */
  const ALLOWED = [
    'lib/i18n/display-format.ts',
    'content/alternatives/alternative-copy.ts',
    'content/compare/compare-copy.ts',
  ];

  function files(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return files(path);
      return /\.(ts|tsx)$/u.test(name) ? [path] : [];
    });
  }

  it('names -u-nu- or numberingSystem only inside the shared rule', () => {
    const offenders = files(SRC)
      .map((path) => relative(SRC, path).replaceAll('\\', '/'))
      .filter((path) => !ALLOWED.includes(path))
      .filter((path) => {
        const code = readFileSync(join(SRC, path), 'utf8')
          .replace(/\/\*[\s\S]*?\*\//gu, '')
          .replace(/^\s*\/\/.*$/gmu, '');
        return /-u-nu-|numberingSystem\s*:/u.test(code);
      });
    expect(offenders).toEqual([]);
  });

  it('never hands the bare appLocale() to Intl (use appIntlLocale or appDateLocale)', () => {
    const offenders = files(SRC)
      .map((path) => relative(SRC, path).replaceAll('\\', '/'))
      .filter((path) =>
        /(?:Intl\.(?:DateTimeFormat|NumberFormat|RelativeTimeFormat)|\.toLocale(?:Date|Time)?String)\(appLocale\(\)/u.test(
          readFileSync(join(SRC, path), 'utf8'),
        ),
      );
    expect(offenders).toEqual([]);
  });
});

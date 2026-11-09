import { afterEach, describe, expect, it } from 'vitest';
import { compactUnit, relativeAgo } from '../src/lib/i18n/compact-time';
import { displayFormat, numericDay, withNumerals } from '../src/lib/i18n/display-format';
import { formatDateTime, formatDay, formatNumber, formatTime } from '../src/lib/i18n/format';
import { pluralPhrase } from '../src/lib/i18n/plural';
import ar from '../src/lib/i18n/messages/ar.json';

/**
 * FIX5 item 6b (B-N7): the profile's `numerals` and `dateFormat` reach every shared formatter, so
 * an Arabic member who saved Latin digits and ISO dates never reads "٩/١١/٢٠٢٦ ١٠:٤١ م".
 */
const ARABIC_INDIC = /[٠-٩]/u;
const AT = '2026-11-09T20:41:00.000Z';
const ctx = { locale: 'ar-EG', timeZone: 'Africa/Cairo' };

afterEach(() => displayFormat.set({}));

describe('withNumerals', () => {
  it('forces the saved digit system through -u-nu-, replacing one already there', () => {
    expect(withNumerals('ar-EG', 'latin')).toBe('ar-EG-u-nu-latn');
    expect(withNumerals('ar-u-nu-latn', 'arabic_indic')).toBe('ar-u-nu-arab');
    expect(withNumerals('ar-EG-u-ca-islamic', 'latin')).toBe('ar-EG-u-nu-latn-ca-islamic');
    expect(withNumerals('ar-EG', undefined)).toBe('ar-EG');
  });
});

describe('the shared formatter honours the profile in Arabic', () => {
  it('latin + ISO: Files dates read 2026-11-09 with Latin digits', () => {
    displayFormat.set({ numerals: 'latin', dateFormat: 'iso' });
    const text = formatDateTime(AT, ctx);
    expect(text.startsWith('2026-11-09 ')).toBe(true);
    expect(text).toMatch(/10:41/u);
    expect(text).not.toMatch(ARABIC_INDIC);
    expect(formatDay(AT, ctx)).toBe('2026-11-09');
  });

  it('counts, times and ages use Latin digits, and ages spell the unit out', () => {
    displayFormat.set({ numerals: 'latin', dateFormat: 'iso' });
    expect(formatNumber(8, ctx)).toBe('8');
    expect(formatTime(AT, ctx)).not.toMatch(ARABIC_INDIC);
    expect(compactUnit(8, 'minute', 'ar-EG')).toBe('8 دقائق');
    expect(compactUnit(7, 'day', 'ar-EG')).toBe('7 أيام');
    expect(relativeAgo(8, 'minute', 'ar-EG')).not.toMatch(ARABIC_INDIC);
    const tr = (_key: string, english: string) => english;
    expect(pluralPhrase(tr, 'ar-EG', 'x', 8, { one: '{count}', other: '{count}' })).toBe('8');
  });

  it('Arabic-Indic digits and the US / EU layouts when saved so', () => {
    displayFormat.set({ numerals: 'arabic_indic', dateFormat: 'eu' });
    expect(formatDay(AT, ctx)).toBe('٠٩/١١/٢٠٢٦');
    expect(numericDay(new Date(AT), 'UTC', { dateFormat: 'us' })).toBe('11/09/2026');
    expect(compactUnit(8, 'minute', 'en-US')).toBe('٨m');
  });

  it('keeps hand-picked date parts in their own layout, with the saved digits', () => {
    displayFormat.set({ numerals: 'latin', dateFormat: 'iso' });
    const text = formatDay(AT, ctx, { day: 'numeric', month: 'short' });
    expect(text).toMatch(/^9 /u);
  });

  it('leaves the locale alone until a profile is published', () => {
    expect(formatNumber(8, ctx)).toBe('٨');
    expect(withNumerals('ar-EG')).toBe('ar-EG');
  });
});

describe('Recently viewed meta line agrees with the kind', () => {
  it('a task (feminine) reads "فُتحت في", the masculine kinds keep "فُتح في"', () => {
    expect(ar['HomeRecentItemsView.viewedPrefixWork']).toBe('فُتحت في');
    expect(ar['HomeRecentItemsView.viewedPrefix']).toBe('فُتح في');
  });
});

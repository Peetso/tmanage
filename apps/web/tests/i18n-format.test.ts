import { describe, expect, it } from 'vitest';
import { formatDateTime, formatDay, formatMoneyMinor, formatNumber } from '../src/lib/i18n/format';

/**
 * i18n Slice 2 — the same value, formatted for the member's locale rather than the browser's.
 *
 * A fixed UTC instant and fixed numbers, formatted for `en-US`, `de-DE` and `ar-EG`, must all
 * three diverge: grouping and decimal marks (en vs de), and Arabic-Indic digits (ar). That is
 * exactly what `Intl.…Format(undefined, …)` could not guarantee, because `undefined` followed
 * the browser. The timezone half is proved separately: one instant, two zones, two wall clocks.
 */
const INSTANT = '2026-01-15T13:45:00.000Z';

function allDistinct(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

describe('numbers follow the active locale', () => {
  it('groups and marks decimals per locale, with Arabic-Indic digits for ar-EG', () => {
    const en = formatNumber(1234567.89, { locale: 'en-US' });
    const de = formatNumber(1234567.89, { locale: 'de-DE' });
    const ar = formatNumber(1234567.89, { locale: 'ar-EG' });

    expect(en).toBe('1,234,567.89');
    expect(de).toBe('1.234.567,89');
    // Arabic-Indic digits (U+0660–U+0669), never ASCII digits.
    expect(ar).toMatch(/[٠-٩]/u);
    expect(ar).not.toMatch(/[0-9]/u);
    expect(allDistinct([en, de, ar])).toBe(true);
  });
});

describe('currency follows the active locale', () => {
  it('places the symbol and groups per locale for the same amount', () => {
    const en = formatMoneyMinor(123456, 'USD', { locale: 'en-US' });
    const de = formatMoneyMinor(123456, 'USD', { locale: 'de-DE' });
    const ar = formatMoneyMinor(123456, 'USD', { locale: 'ar-EG' });

    expect(en).toContain('1,234.56');
    expect(de).toContain('1.234,56');
    expect(ar).toMatch(/[٠-٩]/u);
    expect(allDistinct([en, de, ar])).toBe(true);
  });

  it('falls back to major units and the code for a malformed currency instead of throwing', () => {
    // A valid-format-but-unknown code (ZZZ) renders through Intl without throwing; a malformed
    // one (XX) makes Intl throw, and the fallback keeps that out of the render.
    expect(formatMoneyMinor(123456, 'ZZZ', { locale: 'en-US' })).toContain('1,234.56');
    expect(formatMoneyMinor(123456, 'XX', { locale: 'en-US' })).toBe('1234.56 XX');
  });
});

describe('dates follow the active locale and timezone', () => {
  it('formats the same instant differently per locale', () => {
    const en = formatDay(INSTANT, { locale: 'en-US' }, { dateStyle: 'medium', timeZone: 'UTC' });
    const de = formatDay(INSTANT, { locale: 'de-DE' }, { dateStyle: 'medium', timeZone: 'UTC' });
    const ar = formatDay(INSTANT, { locale: 'ar-EG' }, { dateStyle: 'medium', timeZone: 'UTC' });
    expect(allDistinct([en, de, ar])).toBe(true);
    expect(ar).toMatch(/[٠-٩]/u);
  });

  it('reads one instant as two wall clocks in two timezones', () => {
    const utc = formatDateTime(INSTANT, { locale: 'en-US', timeZone: 'UTC' });
    const tokyo = formatDateTime(INSTANT, { locale: 'en-US', timeZone: 'Asia/Tokyo' });
    expect(utc).not.toBe(tokyo);
    expect(utc).toContain('1:45');
    expect(tokyo).toContain('10:45');
  });

  it('returns an unparseable instant verbatim rather than "Invalid Date"', () => {
    expect(formatDay('not-a-date', { locale: 'en-US' })).toBe('not-a-date');
  });
});

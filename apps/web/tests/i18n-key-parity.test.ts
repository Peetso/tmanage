import { describe, expect, it } from 'vitest';
import en from '../src/lib/i18n/messages/en.json';
import ar from '../src/lib/i18n/messages/ar.json';
import { translate } from '../src/lib/i18n/t';

/**
 * i18n Slice 3 — the check that fails on a missing translation.
 *
 * `en.json` is the source of truth for the key set; `ar.json` must mirror it exactly. This test
 * fails the build when a key is added to English and not translated into Arabic, or when a stray
 * Arabic key has no English counterpart — the drift that otherwise ships a blank or an English
 * string into the Arabic UI unnoticed.
 */
const enKeys = Object.keys(en).sort();
const arKeys = Object.keys(ar).sort();

describe('message catalog parity (en <-> ar)', () => {
  it('ar.json translates every en.json key', () => {
    const missingInArabic = enKeys.filter((key) => !(key in ar));
    expect(missingInArabic, 'keys present in en.json but missing from ar.json').toEqual([]);
  });

  it('ar.json has no key en.json lacks', () => {
    const strayInArabic = arKeys.filter((key) => !(key in en));
    expect(strayInArabic, 'keys present in ar.json but missing from en.json').toEqual([]);
  });

  it('every catalog value is a non-empty string', () => {
    for (const [key, value] of [...Object.entries(en), ...Object.entries(ar)]) {
      expect(typeof value, `${key} must be a string`).toBe('string');
      expect((value as string).trim().length, `${key} must be non-empty`).toBeGreaterThan(0);
    }
  });
});

describe('translate() resolves and falls back', () => {
  it('returns the Arabic string for an ar locale and the English string for others', () => {
    expect(translate('ar-EG', 'displayPreferences.save')).toBe(ar['displayPreferences.save']);
    expect(translate('en-US', 'displayPreferences.save')).toBe(en['displayPreferences.save']);
    // A locale with no catalog of its own falls back to English, never to a blank.
    expect(translate('de-DE', 'displayPreferences.save')).toBe(en['displayPreferences.save']);
  });
});

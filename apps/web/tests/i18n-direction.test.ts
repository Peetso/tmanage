import { describe, expect, it } from 'vitest';
import { DISPLAY_LOCALES } from '../src/lib/api/display-preferences';
import { localeDirection } from '../src/lib/i18n/direction';
import { DEFAULT_LOCALE, LocaleStore } from '../src/lib/i18n/locale-store';

/**
 * i18n Slice 1 — Arabic is selectable, and the active locale drives the writing direction.
 *
 * The regressions this guards: `ar-EG` dropping off the allowlist (making the one RTL locale
 * unreachable again), and `dir` being decided by anything other than the locale's script.
 */
describe('writing direction follows the locale script', () => {
  it('maps Arabic to rtl and the Latin-script locales to ltr', () => {
    expect(localeDirection('ar-EG')).toBe('rtl');
    expect(localeDirection('ar')).toBe('rtl');
    expect(localeDirection('en-US')).toBe('ltr');
    expect(localeDirection('de-DE')).toBe('ltr');
    expect(localeDirection('ja-JP')).toBe('ltr');
  });

  it('treats case and unknown/malformed tags safely', () => {
    expect(localeDirection('AR-eg')).toBe('rtl');
    expect(localeDirection('he-IL')).toBe('rtl');
    expect(localeDirection('')).toBe('ltr');
    expect(localeDirection('not-a-locale')).toBe('ltr');
  });
});

describe('the display-locale allowlist', () => {
  it('includes ar-EG so Arabic can be selected and saved', () => {
    expect(DISPLAY_LOCALES).toContain('ar-EG');
  });

  it('still ships en-US as the default', () => {
    expect(DISPLAY_LOCALES).toContain('en-US');
    expect(DEFAULT_LOCALE).toBe('en-US');
  });
});

describe('the active-locale store', () => {
  it('defaults to en-US and publishes allowlisted changes to subscribers', () => {
    const store = new LocaleStore('en-US');
    const seen: string[] = [];
    const unsubscribe = store.subscribe((locale) => seen.push(locale));

    store.set('ar-EG');
    expect(store.get()).toBe('ar-EG');
    expect(localeDirection(store.get())).toBe('rtl');

    // A no-op change wakes nobody; an off-allowlist value is ignored, not stored.
    store.set('ar-EG');
    store.set('xx-YY' as never);
    expect(seen).toEqual(['ar-EG']);
    expect(store.get()).toBe('ar-EG');

    unsubscribe();
    store.set('en-US');
    expect(seen).toEqual(['ar-EG']);
  });
});

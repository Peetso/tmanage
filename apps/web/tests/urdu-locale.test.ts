import { describe, expect, it } from 'vitest';
import en from '../src/lib/i18n/messages/en.json';
import ur from '../src/lib/i18n/messages/ur.json';
import { DISPLAY_LOCALES } from '../src/lib/api/display-preferences';
import {
  CATALOG_STATUS,
  OFFERED_LOCALES,
  catalogNameOf,
  isBetaLocale,
  localeLangAttribute,
  localeNativeName,
} from '../src/lib/i18n/catalog-status';
import { localeDirection } from '../src/lib/i18n/direction';
import { localeFromLangParam } from '../src/lib/i18n/locale-boot';
import { offeredLocaleFor } from '../src/lib/i18n/locale-hint';
import { translate } from '../src/lib/i18n/t';

/**
 * Slice 54-21 — Urdu (ur-PK): offered beside Arabic, right-to-left, a partial catalog whose
 * untranslated keys fall back to English (Figma "54-21 · Urdu (ur-PK) locale" 577:32841).
 */
describe('Urdu in the locale registry', () => {
  it('is allowlisted, offered, named in itself and marked Beta', () => {
    expect(DISPLAY_LOCALES).toContain('ur-PK');
    expect(OFFERED_LOCALES).toContain('ur-PK');
    expect(catalogNameOf('ur-PK')).toBe('ur');
    expect(CATALOG_STATUS.ur).toBe('partial');
    expect(localeNativeName('ur-PK')).toBe('اردو');
    expect(localeLangAttribute('ur-PK')).toBe('ur');
    expect(isBetaLocale('ur-PK')).toBe(true);
    expect(isBetaLocale('ar-EG')).toBe(false);
  });

  it('is reached from ?lang=ur and from an Urdu browser', () => {
    expect(localeFromLangParam('ur')).toBe('ur-PK');
    expect(offeredLocaleFor('ur-IN')).toBe('ur-PK');
  });
});

describe('Urdu direction', () => {
  it('reads right-to-left', () => {
    expect(localeDirection('ur-PK')).toBe('rtl');
  });
});

describe('Urdu catalog fallback', () => {
  it('reads Urdu for a core key and English for a key the catalog leaves out', () => {
    expect(translate('ur-PK', 'nav.home')).toBe(ur['nav.home']);
    expect(translate('ur-PK', 'nav.home')).not.toBe(en['nav.home']);
    const missing = Object.keys(en).find((key) => !(key in ur)) as keyof typeof en;
    expect(missing).toBeDefined();
    expect(translate('ur-PK', missing)).toBe(en[missing]);
  });
});

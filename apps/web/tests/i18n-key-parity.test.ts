import { describe, expect, it } from 'vitest';
import en from '../src/lib/i18n/messages/en.json';
import ar from '../src/lib/i18n/messages/ar.json';
import es from '../src/lib/i18n/messages/es.json';
import fr from '../src/lib/i18n/messages/fr.json';
import ptBR from '../src/lib/i18n/messages/pt-BR.json';
import de from '../src/lib/i18n/messages/de.json';
import zhCN from '../src/lib/i18n/messages/zh-CN.json';
import { languageOf, translate } from '../src/lib/i18n/t';
import { CATALOG_STATUS, OFFERED_LOCALES, type CatalogName } from '../src/lib/i18n/catalog-status';
import { checkCatalog } from '../../../scripts/i18n/check-catalog.mjs';

/**
 * i18n Slice 3, R12 R2 — the check that fails on a drifting catalog.
 *
 * `en.json` is the source of truth for the key set. Arabic and any `reviewed` catalog mirror it
 * exactly; a `beta` catalog (`catalog-status.ts`) may trail by at most 1 % (listed in the output,
 * since the English keys move while a language worker translates) but never carries a stray key, an
 * empty value or a line that lost one of the English `{placeholder}`s. The rules live in
 * `scripts/i18n/check-catalog.mjs`, which the language workers run by hand.
 */
const CATALOGS: Readonly<Record<CatalogName, Record<string, unknown>>> = {
  ar,
  es,
  fr,
  'pt-BR': ptBR,
  de,
  'zh-CN': zhCN,
};

describe('message catalog parity', () => {
  for (const [name, catalog] of Object.entries(CATALOGS) as [
    CatalogName,
    Record<string, unknown>,
  ][]) {
    const strict = name === 'ar' || CATALOG_STATUS[name] === 'reviewed';
    it(`${name}.json follows en.json (${strict ? 'strict' : 'beta'})`, () => {
      const result = checkCatalog(en, catalog, { strict });
      if (result.missing.length > 0) console.info(`${name}.json missing:`, result.missing);
      expect(result.stray, 'keys en.json lacks').toEqual([]);
      expect(result.empty, 'empty values').toEqual([]);
      if (strict) expect(result.missing, 'keys missing').toEqual([]);
      else expect(result.placeholder, 'lost placeholders').toEqual([]);
      expect(result.ok).toBe(true);
    });
  }

  it('fails a catalog with one stray key', () => {
    expect(checkCatalog({ a: 'A {n}' }, { a: 'A {n}', b: 'B' }).ok).toBe(false);
    expect(checkCatalog({ a: 'A {n}' }, { a: 'A' }).placeholder).toEqual(['a {n}']);
  });
});

describe('translate() resolves and falls back', () => {
  it('reads each language catalog and falls back to English', () => {
    expect(['es-MX', 'fr-CA', 'pt-PT', 'de-AT', 'zh-CN', 'ar-SA', 'ja-JP'].map(languageOf)).toEqual(
      ['es', 'fr', 'pt-BR', 'de', 'zh-CN', 'ar', 'en'],
    );
    expect(translate('ar-EG', 'displayPreferences.save')).toBe(ar['displayPreferences.save']);
    expect(translate('ja-JP', 'displayPreferences.save')).toBe(en['displayPreferences.save']);
  });

  it('offers eight locales and hides ja-JP', () => {
    expect(OFFERED_LOCALES).toHaveLength(8);
    expect(OFFERED_LOCALES).not.toContain('ja-JP');
  });
});

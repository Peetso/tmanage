import en from './messages/en.json';
import ar from './messages/ar.json';

/**
 * i18n (NFR-02, I18N-03/05/06) — the message catalog and its lookup, dependency-free.
 *
 * No i18n library resolves offline from the lockfile, so translation here is a native lookup over
 * two hand-kept JSON catalogs: `en.json` is the source of truth for the key set (and the fallback
 * for any locale), `ar.json` its Arabic mirror. `t(locale, key)` resolves the active locale's
 * catalog, falls back to English for a key that catalog is missing, and finally to the key itself
 * so a never-translated string is still a recognisable string rather than a blank.
 *
 * The key set is `keyof typeof en`, so a `t()` call with a key that does not exist is a *compile*
 * error, and `i18n-key-parity.test.ts` fails the build if `ar.json` drifts from `en.json`. That
 * pairing — typed keys plus a parity test — is the "check that fails on missing keys" the brief
 * asks for: a key can neither be mistyped at a call site nor left untranslated in `ar.json`.
 */

/** Every message key, taken from the English catalog so call sites are checked against it. */
export type MessageKey = keyof typeof en;

const CATALOGS = { en, ar } as const;
type CatalogLanguage = keyof typeof CATALOGS;

const EN: Record<string, string> = en;

/** The catalog language for a BCP-47 locale: Arabic for `ar-*`, English for everything else. */
function languageOf(locale: string): CatalogLanguage {
  return locale.split('-')[0]?.toLowerCase() === 'ar' ? 'ar' : 'en';
}

/**
 * Translate `key` for `locale`. Falls back to the English string, then to the key, so the result
 * is always a non-empty, recognisable string.
 */
export function translate(locale: string, key: MessageKey): string {
  const catalog: Record<string, string> = CATALOGS[languageOf(locale)];
  return catalog[key] ?? EN[key] ?? key;
}

import en from './messages/en.json';
import ar from './messages/ar.json';
import es from './messages/es.json';
import fr from './messages/fr.json';
import ptBR from './messages/pt-BR.json';
import de from './messages/de.json';
import zhCN from './messages/zh-CN.json';
import { catalogNameOf, type CatalogName } from './catalog-status';

/**
 * i18n (NFR-02, I18N-03/05/06; R12 R2) — the message catalogs and their lookup, dependency-free.
 *
 * No i18n library resolves offline from the lockfile, so translation here is a native lookup over
 * hand-kept JSON catalogs: `en.json` is the source of truth for the key set (and the fallback for
 * any locale), `ar.json` its reviewed Arabic mirror, and `es`, `fr`, `pt-BR`, `de`, `zh-CN` the
 * beta catalogs (`catalog-status.ts`), each replaced by its own language worker. `t(locale, key)`
 * resolves the active locale's catalog, falls back to English for a key that catalog is missing,
 * and finally to the key itself so a never-translated string is still a recognisable string.
 *
 * The key set is `keyof typeof en`, so a `t()` call with a key that does not exist is a *compile*
 * error, and `i18n-key-parity.test.ts` fails the build when a catalog drifts from `en.json`.
 */

/** Every message key, taken from the English catalog so call sites are checked against it. */
export type MessageKey = keyof typeof en;

const CATALOGS: Readonly<Record<CatalogName | 'en', Record<string, string>>> = {
  en,
  ar,
  es,
  fr,
  'pt-BR': ptBR,
  de,
  'zh-CN': zhCN,
};

const EN: Record<string, string> = en;

/** The catalog for a BCP-47 locale: ar, es, fr, pt → pt-BR, de, zh → zh-CN, English otherwise. */
export function languageOf(locale: string): CatalogName | 'en' {
  return catalogNameOf(locale);
}

/**
 * Translate `key` for `locale`. Falls back to the English string, then to the key, so the result
 * is always a non-empty, recognisable string.
 */
export function translate(locale: string, key: MessageKey): string {
  const catalog = CATALOGS[languageOf(locale)];
  return catalog[key] ?? EN[key] ?? key;
}

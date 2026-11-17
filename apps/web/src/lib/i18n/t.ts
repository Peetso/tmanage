import { importCatalog, PRELOADED_CATALOGS } from '#i18n-catalogs';
import en from './messages/en.json';
import { catalogNameOf, type CatalogName } from './catalog-status';

/**
 * i18n (NFR-02, I18N-03/05/06; R12 R2) — the message catalogs and their lookup, dependency-free.
 *
 * No i18n library resolves offline from the lockfile, so translation here is a native lookup over
 * hand-kept JSON catalogs: `en.json` is the source of truth for the key set (and the fallback for
 * any locale), `ar.json` its reviewed Arabic mirror, and `es`, `fr`, `pt-BR`, `de`, `zh-CN` the
 * beta catalogs (`catalog-status.ts`), each replaced by its own language worker, and `ur` the
 * partial Urdu catalog (slice 54-21: core namespaces only, the rest falls back to English). `t(locale, key)`
 * resolves the active locale's catalog, falls back to English for a key that catalog is missing,
 * and finally to the key itself so a never-translated string is still a recognisable string.
 *
 * The key set is `keyof typeof en`, so a `t()` call with a key that does not exist is a *compile*
 * error, and `i18n-key-parity.test.ts` fails the build when a catalog drifts from `en.json`.
 */

/** Every message key, taken from the English catalog so call sites are checked against it. */
export type MessageKey = keyof typeof en;

/**
 * The catalogs this process holds. On the server (and in the tests) `#i18n-catalogs` preloads all
 * of them; in the browser only English is bundled and a language arrives through
 * {@link loadCatalog} before anything is shown in it (`use-catalog.ts`, `locale-store.ts`).
 */
const CATALOGS: Partial<Record<CatalogName | 'en', Record<string, string>>> = {
  en,
  ...PRELOADED_CATALOGS,
};

/** One download per language for the tab's lifetime; a failed one settles too (English then). */
const LOADING = new Map<CatalogName, Promise<void>>();

const EN: Record<string, string> = en;

/** The catalog for a BCP-47 locale: ar, es, fr, pt → pt-BR, de, zh → zh-CN, ur, else English. */
export function languageOf(locale: string): CatalogName | 'en' {
  return catalogNameOf(locale);
}

/**
 * Translate `key` for `locale`. Falls back to the English string, then to the key, so the result
 * is always a non-empty, recognisable string.
 */
export function translate(locale: string, key: MessageKey): string {
  const catalog = CATALOGS[languageOf(locale)];
  return catalog?.[key] ?? EN[key] ?? key;
}

/** Whether `locale`'s catalog is here, so {@link translate} answers in that language right now. */
export function catalogReady(locale: string): boolean {
  return CATALOGS[languageOf(locale)] !== undefined;
}

/**
 * Make `locale`'s catalog available. Resolves at once when it already is; never rejects, because a
 * download that fails leaves the English fallback, which is what a missing key shows anyway. The
 * promise is stable per language, so React's `use()` can wait on it.
 */
export function loadCatalog(locale: string): Promise<void> {
  const name = languageOf(locale);
  if (name === 'en' || CATALOGS[name] !== undefined) return Promise.resolve();
  let pending = LOADING.get(name);
  if (pending === undefined) {
    pending = importCatalog(name).then(
      (messages) => {
        if (messages !== undefined) CATALOGS[name] = messages;
      },
      (error: unknown) => {
        console.error(`[i18n] the ${name} catalog did not load`, error);
      },
    );
    LOADING.set(name, pending);
  }
  return pending;
}

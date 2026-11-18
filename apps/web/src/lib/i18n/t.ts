import { importCatalog, PRELOADED_CATALOGS } from '#i18n-catalogs';
import { ALL_PARTS, SITE_PARTS, type CatalogPart } from './catalog-part';
import { catalogNameOf, type CatalogName } from './catalog-status';
import type en from './messages/en.json';

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

/** A catalog language: English (the source of truth and the fallback) or one of the others. */
type Language = CatalogName | 'en';

/**
 * The catalogs this process holds. On the server (and in the tests) `#i18n-catalogs` preloads all
 * of them whole; in the browser none is bundled (CATSPLIT): each language arrives in parts
 * (`catalog-part.ts`) through {@link loadCatalog} before anything is shown in it
 * (`use-catalog.ts`, `locale-store.ts`). A part already carries the English line for any key its
 * language lacks, so a page never needs the English catalog beside its own.
 */
const CATALOGS: Partial<Record<Language, Record<string, string>>> = { ...PRELOADED_CATALOGS };

const LANGUAGES: readonly Language[] = ['en', 'ar', 'es', 'fr', 'pt-BR', 'de', 'zh-CN', 'ur'];

/** The parts each language has here; a preloaded catalog is whole. */
const HELD = new Map<Language, Set<CatalogPart>>(
  LANGUAGES.filter((language) => PRELOADED_CATALOGS[language] !== undefined).map((language) => [
    language,
    new Set(ALL_PARTS),
  ]),
);

/** One download per language and part for the tab's lifetime; a failed one settles too (the key then). */
const LOADING = new Map<string, Promise<void>>();

/** One stable promise per language and set of parts, so React's `use()` can wait on it. */
const WAITING = new Map<string, Promise<void>>();

/**
 * The parts the tab has rendered from so far. A language switch publishes only once all of them
 * have arrived in the new language, so a signed-in screen never shows a key.
 */
const DEMANDED = new Set<CatalogPart>(SITE_PARTS);

/** The catalog for a BCP-47 locale: ar, es, fr, pt → pt-BR, de, zh → zh-CN, ur, else English. */
export function languageOf(locale: string): Language {
  return catalogNameOf(locale);
}

/**
 * Translate `key` for `locale`. Falls back to the English string, then to the key, so the result
 * is always a non-empty, recognisable string.
 */
export function translate(locale: string, key: MessageKey): string {
  const catalog = CATALOGS[languageOf(locale)];
  return catalog?.[key] ?? CATALOGS.en?.[key] ?? key;
}

/** Record that the tab renders from `parts`, so a later language switch waits for them too. */
export function demandParts(parts: readonly CatalogPart[]): void {
  for (const part of parts) DEMANDED.add(part);
}

/**
 * Whether `locale`'s catalog parts are here, so {@link translate} answers in that language right
 * now. Without `parts`: every part the tab has rendered from.
 */
export function catalogReady(
  locale: string,
  parts: readonly CatalogPart[] = [...DEMANDED],
): boolean {
  const held = HELD.get(languageOf(locale));
  return parts.every((part) => held?.has(part) === true);
}

function loadPart(language: Language, part: CatalogPart): Promise<void> {
  const id = `${language}.${part}`;
  let pending = LOADING.get(id);
  if (pending === undefined) {
    pending = importCatalog(language, part).then(
      (messages) => {
        if (messages === undefined) return;
        CATALOGS[language] = { ...CATALOGS[language], ...messages };
        const held = HELD.get(language) ?? new Set<CatalogPart>();
        held.add(part);
        HELD.set(language, held);
      },
      (error: unknown) => {
        console.error(`[i18n] the ${id} catalog did not load`, error);
      },
    );
    LOADING.set(id, pending);
  }
  return pending;
}

/**
 * Make `locale`'s catalog parts available (without `parts`: every part the tab has rendered from).
 * Resolves at once when they already are; never rejects, because a download that fails leaves the
 * English line or the key. The promise is stable per language and parts.
 */
export function loadCatalog(
  locale: string,
  parts: readonly CatalogPart[] = [...DEMANDED],
): Promise<void> {
  const language = languageOf(locale);
  if (catalogReady(locale, parts)) return Promise.resolve();
  const id = `${language}:${parts.join('+')}`;
  let waiting = WAITING.get(id);
  if (waiting === undefined) {
    waiting = Promise.all(parts.map((part) => loadPart(language, part))).then(() => undefined);
    WAITING.set(id, waiting);
  }
  return waiting;
}

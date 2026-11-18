import { PRELOADED_CATALOGS } from './catalogs-all';
import { isCatalogPart, partOfKey, type CatalogPart } from './catalog-part';
import { CATALOG_VERSION } from './catalog-part-path';
import type { CatalogName } from './catalog-status';

/**
 * CATSPLIT, server side: one part of one language's catalog as the browser fetches it
 * (`catalogs-lazy.ts`). Every key of the part is present: a key the language lacks carries the
 * English line, which is the fallback `translate()` gives on the server too. Public text only, the
 * same for every visitor, so the answer is cached; under the current catalog version for a year.
 */
const LANGUAGES: ReadonlySet<string> = new Set<CatalogName | 'en'>([
  'en',
  'ar',
  'es',
  'fr',
  'pt-BR',
  'de',
  'zh-CN',
  'ur',
]);

const FILE = /^([A-Za-z-]+)\.([a-z]+)\.json$/u;

const BUILT = new Map<string, string>();

function isLanguage(value: string): value is CatalogName | 'en' {
  return LANGUAGES.has(value);
}

function partBody(language: CatalogName | 'en', part: CatalogPart): string {
  const id = `${language}.${part}`;
  const cached = BUILT.get(id);
  if (cached !== undefined) return cached;
  const en = PRELOADED_CATALOGS.en ?? {};
  const own = PRELOADED_CATALOGS[language] ?? {};
  const messages: Record<string, string> = {};
  for (const [key, english] of Object.entries(en)) {
    if (partOfKey(key) === part) messages[key] = own[key] ?? english;
  }
  const body = JSON.stringify(messages);
  BUILT.set(id, body);
  return body;
}

/** The response for `/i18n/<file>`; `version` is the `?v=` the page asked with. */
export function catalogPartResponse(file: string, version: string | null): Response {
  const match = FILE.exec(file);
  const language = match?.[1] ?? '';
  const part = match?.[2] ?? '';
  if (!isLanguage(language) || !isCatalogPart(part)) {
    return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
  }
  const current = version === CATALOG_VERSION;
  return new Response(partBody(language, part), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': current ? 'public, max-age=31536000, immutable' : 'no-cache',
    },
  });
}

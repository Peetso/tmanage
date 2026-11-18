import ar from './messages/ar.json';
import de from './messages/de.json';
import en from './messages/en.json';
import es from './messages/es.json';
import fr from './messages/fr.json';
import ptBR from './messages/pt-BR.json';
import ur from './messages/ur.json';
import zhCN from './messages/zh-CN.json';
import type { CatalogPart } from './catalog-part';
import type { CatalogName } from './catalog-status';

/**
 * `#i18n-catalogs` for the server (and the tests): every catalog, English included, loaded whole up
 * front, so a server render translates synchronously in any language. The browser resolves the
 * same specifier to `catalogs-lazy.ts` (package.json `imports`, `browser` condition) and fetches
 * only the parts of the language it shows (CATSPLIT, `catalog-part.ts`).
 */
export const PRELOADED_CATALOGS: Readonly<
  Partial<Record<CatalogName | 'en', Record<string, string>>>
> = {
  en,
  ar,
  de,
  es,
  fr,
  'pt-BR': ptBR,
  ur,
  'zh-CN': zhCN,
};

/** Already loaded whole; resolves at once (the lazy twin downloads one part). */
export function importCatalog(
  name: CatalogName | 'en',
  _part: CatalogPart,
): Promise<Record<string, string> | undefined> {
  return Promise.resolve(PRELOADED_CATALOGS[name]);
}

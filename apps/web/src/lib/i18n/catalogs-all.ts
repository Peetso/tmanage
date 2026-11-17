import ar from './messages/ar.json';
import de from './messages/de.json';
import es from './messages/es.json';
import fr from './messages/fr.json';
import ptBR from './messages/pt-BR.json';
import ur from './messages/ur.json';
import zhCN from './messages/zh-CN.json';
import type { CatalogName } from './catalog-status';

/**
 * `#i18n-catalogs` for the server (and the tests): every non-English catalog, loaded up front, so a
 * server render translates synchronously in any language. The browser resolves the same specifier
 * to `catalogs-lazy.ts` (package.json `imports`, `browser` condition) and fetches only the language
 * it shows. English is not here: `t.ts` imports it itself, as the fallback and the key set.
 */
export const PRELOADED_CATALOGS: Readonly<Partial<Record<CatalogName, Record<string, string>>>> = {
  ar,
  de,
  es,
  fr,
  'pt-BR': ptBR,
  ur,
  'zh-CN': zhCN,
};

/** Already loaded; resolves at once (the lazy twin downloads the language's chunk). */
export function importCatalog(name: CatalogName): Promise<Record<string, string> | undefined> {
  return Promise.resolve(PRELOADED_CATALOGS[name]);
}

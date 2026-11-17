import type { CatalogName } from './catalog-status';

/**
 * `#i18n-catalogs` in the browser (package.json `imports`, `browser` condition): no catalog is
 * bundled up front, and each language is its own chunk, downloaded only when the page is shown in
 * it. Bundling all seven made every route load about 9 MB of JavaScript (DOMAINIMPORT2). The server
 * resolves the specifier to `catalogs-all.ts`, so server renders stay synchronous.
 */
export const PRELOADED_CATALOGS: Readonly<Partial<Record<CatalogName, Record<string, string>>>> =
  {};

/** Download one language's catalog. */
export async function importCatalog(
  name: CatalogName,
): Promise<Record<string, string> | undefined> {
  switch (name) {
    case 'ar':
      return (await import('./messages/ar.json')).default;
    case 'de':
      return (await import('./messages/de.json')).default;
    case 'es':
      return (await import('./messages/es.json')).default;
    case 'fr':
      return (await import('./messages/fr.json')).default;
    case 'pt-BR':
      return (await import('./messages/pt-BR.json')).default;
    case 'ur':
      return (await import('./messages/ur.json')).default;
    case 'zh-CN':
      return (await import('./messages/zh-CN.json')).default;
  }
}

import { catalogPartPath } from './catalog-part-path';
import type { CatalogPart } from './catalog-part';
import type { CatalogName } from './catalog-status';

/**
 * `#i18n-catalogs` in the browser (package.json `imports`, `browser` condition): no catalog is
 * bundled, not even English (CATSPLIT). Each language comes in two parts (`catalog-part.ts`),
 * served as JSON by `app/i18n/[catalog]/route.ts` under the build's catalog version, so a public
 * page downloads only its language's `site` part. Bundling every catalog made each route carry
 * about 9 MB of JavaScript (DOMAINIMPORT2), and English alone 1.2 MB. The server resolves the
 * specifier to `catalogs-all.ts`, so server renders stay synchronous.
 */
export const PRELOADED_CATALOGS: Readonly<
  Partial<Record<CatalogName | 'en', Record<string, string>>>
> = {};

function isMessages(value: unknown): value is Record<string, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.values(value).every((entry) => typeof entry === 'string')
  );
}

/** Download one part of one language's catalog. */
export async function importCatalog(
  name: CatalogName | 'en',
  part: CatalogPart,
): Promise<Record<string, string> | undefined> {
  // Default credentials mode, as the `<head>` preload (`catalog-preload.ts`) asks, so it is reused.
  const response = await fetch(catalogPartPath(name, part));
  if (!response.ok) throw new Error(`catalog ${name}.${part}: HTTP ${response.status}`);
  const body: unknown = await response.json();
  return isMessages(body) ? body : undefined;
}

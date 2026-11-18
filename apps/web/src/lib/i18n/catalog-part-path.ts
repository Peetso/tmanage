import type { CatalogPart } from './catalog-part';
import type { CatalogName } from './catalog-status';

/**
 * CATSPLIT: the build's catalog version (`next.config.ts`, a hash of the catalogs), so a cached
 * part never outlives the deploy that made it.
 */
export const CATALOG_VERSION = process.env['NEXT_PUBLIC_CATALOG_VERSION'] ?? 'dev';

/** Where the browser fetches one part of one language's catalog (`app/i18n/[catalog]/route.ts`). */
export function catalogPartPath(name: CatalogName | 'en', part: CatalogPart): string {
  return `/i18n/${name}.${part}.json?v=${CATALOG_VERSION}`;
}

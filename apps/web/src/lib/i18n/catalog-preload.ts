import { preload } from 'react-dom';
import type { CatalogPart } from './catalog-part';
import { catalogPartPath } from './catalog-part-path';
import type { CatalogName } from './catalog-status';

/**
 * CATSPLIT: name a catalog part in the page's `<head>` (`<link rel="preload" as="fetch">`), so it
 * downloads beside the scripts instead of after them and hydration rarely has to wait for it. The
 * fetch in `catalogs-lazy.ts` uses the same address and credentials mode, so it reuses the answer.
 */
export function preloadCatalogPart(name: CatalogName | 'en', part: CatalogPart): void {
  preload(catalogPartPath(name, part), { as: 'fetch', crossOrigin: 'anonymous' });
}

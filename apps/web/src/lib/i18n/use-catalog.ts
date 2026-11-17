'use client';

import { use } from 'react';
import { catalogReady, loadCatalog } from './t';

/**
 * Wait (suspend) until `locale`'s catalog is here (DOMAINIMPORT2). The browser bundles English
 * only; a page rendered in another language keeps its server HTML while the language's chunk
 * downloads, then hydrates in the same words, so there is no mismatch and no English flash. On the
 * server every catalog is preloaded and this never waits.
 */
export function useCatalog(locale: string): void {
  if (!catalogReady(locale)) use(loadCatalog(locale));
}

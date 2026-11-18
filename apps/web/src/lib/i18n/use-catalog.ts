'use client';

import { use } from 'react';
import type { CatalogPart } from './catalog-part';
import { useCatalogScope } from './catalog-scope';
import { catalogReady, demandParts, loadCatalog } from './t';

/**
 * Wait (suspend) until `locale`'s catalog parts are here (DOMAINIMPORT2, CATSPLIT). The browser
 * bundles no catalog; a page keeps its server HTML while its language's parts download, then
 * hydrates in the same words, so there is no mismatch and no flash of keys. The parts are the
 * subtree's scope (`catalog-scope.tsx`) unless named. On the server every catalog is preloaded and
 * this never waits.
 */
export function useCatalog(locale: string, parts?: readonly CatalogPart[]): void {
  const scope = useCatalogScope();
  const needed = parts ?? scope;
  demandParts(needed);
  // `use()` on every render, never behind a condition: a component that suspended on it must call
  // it again when it resumes, or React reports an incorrect use of `use()`. Ready reads at once.
  use(catalogReady(locale, needed) ? SETTLED : loadCatalog(locale, needed));
}

/** An already settled promise in the thenable shape React's `use()` reads without suspending. */
const SETTLED: Promise<void> = Object.assign(Promise.resolve(), {
  status: 'fulfilled',
  value: undefined,
});

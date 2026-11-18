'use client';

import { createContext, useContext, type ReactNode } from 'react';
import { ALL_PARTS, SITE_PARTS, type CatalogPart } from './catalog-part';

/**
 * CATSPLIT: which catalog parts the screens below need (`catalog-part.ts`). The root layout's own
 * providers and toasts need the `site` part only (the default); the root layout opens the `app`
 * scope around its routes, and the public website's layouts close it again, so a website page
 * downloads its language's `site` part and nothing else.
 */
const CatalogScopeContext = createContext<readonly CatalogPart[]>(SITE_PARTS);

/** The catalog parts the current subtree renders from. */
export function useCatalogScope(): readonly CatalogPart[] {
  return useContext(CatalogScopeContext);
}

export function CatalogScope({ scope, children }: { scope: 'site' | 'app'; children: ReactNode }) {
  return (
    <CatalogScopeContext.Provider value={scope === 'site' ? SITE_PARTS : ALL_PARTS}>
      {children}
    </CatalogScopeContext.Provider>
  );
}

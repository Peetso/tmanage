import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { PublicLocaleAlternates } from '../../components/website/PublicLocaleAlternates';
import { authPageRobots } from '../../lib/i18n/public-locale-routes';
import { routeTitle } from '../../lib/route-titles';

/**
 * FIX6 locale flash: rendered per request, so the first HTML is in the member's saved language
 * (`lib/i18n/server-html-attributes.ts`) rather than the English prerender.
 */
export const dynamic = 'force-dynamic';

/**
 * Gives the client page `/sign-in` its tab title (a `'use client'` page cannot export `metadata`;
 * `RouteDocumentTitle` writes the name in the active locale) and its `hreflang` link to
 * `/ar/sign-in`. Not indexed, like its Arabic twin (`authPageRobots`).
 */
export const metadata: Metadata = {
  title: routeTitle('/sign-in'),
  robots: authPageRobots('/sign-in'),
};

export default function SignInLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <PublicLocaleAlternates />
      {children}
    </>
  );
}

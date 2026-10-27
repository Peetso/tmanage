import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { PublicLocaleAlternates } from '../../components/website/PublicLocaleAlternates';
import { routeTitle } from '../../lib/route-titles';

/**
 * Gives the client page `/sign-in` its tab title (a `'use client'` page cannot export `metadata`;
 * `RouteDocumentTitle` writes the name in the active locale) and its `hreflang` link to
 * `/ar/sign-in`.
 */
export const metadata: Metadata = { title: routeTitle('/sign-in') };

export default function SignInLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <PublicLocaleAlternates />
      {children}
    </>
  );
}

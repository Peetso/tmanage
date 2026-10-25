import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { routeTitle } from '../../lib/route-titles';

/**
 * Exists only to give the client page `/sign-in` its tab title: a `'use client'` page cannot
 * export `metadata`. `RouteDocumentTitle` writes the name in the active locale.
 */
export const metadata: Metadata = { title: routeTitle('/sign-in') };

export default function SignInLayout({ children }: { children: ReactNode }) {
  return children;
}

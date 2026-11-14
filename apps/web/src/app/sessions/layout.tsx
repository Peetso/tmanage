import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { routeTitle } from '../../lib/route-titles';

/**
 * FIX6 locale flash: rendered per request, so the first HTML is in the member's saved language
 * (`lib/i18n/server-html-attributes.ts`) rather than the English prerender.
 */
export const dynamic = 'force-dynamic';

/**
 * Exists only to give the client page `/sessions` its tab title: a `'use client'` page cannot
 * export `metadata`. `RouteDocumentTitle` writes the name in the active locale.
 */
export const metadata: Metadata = { title: routeTitle('/sessions') };

export default function SessionsLayout({ children }: { children: ReactNode }) {
  return children;
}

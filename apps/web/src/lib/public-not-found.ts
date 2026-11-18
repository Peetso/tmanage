import { englishPublicPath, hasArabicTwin, isArabicPublicPath } from './i18n/public-locale-routes';
import { NOT_FOUND_PAGE } from './workspace-gate';

/**
 * NEXTUP — the not-found page of the public website, server-rendered.
 *
 * A `notFound()` thrown while a request renders (an unknown `/help/<slug>`, `/compare/<slug>` or
 * `/ar/...`) answers 404 with an empty `<body>`: the not-found screen travels only in the flight
 * data and is drawn by script, so a crawler, a reader without script and the first paint see a
 * blank page (live 2026-11-16, Next 16.4.2 and 16.4.5 alike). The prerendered not-found pages hold
 * the whole screen in their HTML, so `src/proxy.ts` answers these paths with one of them and
 * status 404, under that page's own CSP script hashes — CSP and Trusted Types are unchanged.
 *
 * Which pages exist is read from the same tables the routes prerender from
 * (`generateStaticParams`), so a page added there is never answered as missing.
 */

/** The prerendered Arabic not-found page (`app/ar/(site)/page-not-found`). */
export const ARABIC_NOT_FOUND_PAGE = '/ar/page-not-found';

/** English public sections whose `[slug]` page calls `notFound()` for an unknown slug. */
const ENGLISH_SLUG_SECTIONS = [
  '/help/',
  '/compare/',
  '/switch/',
  '/alternatives/',
  // 57-07 (MENA): the use-case pages.
  '/arabic/',
] as const;

/**
 * The prerendered not-found page `pathname` is answered with, or `undefined` when the path is a
 * page that exists (or is not a public website path this knows about).
 *
 * - `/ar` and everything under it: the Arabic not-found page unless the path is the Arabic twin
 *   of an existing page (the catch-all, help, compare, resources, sign-in and sign-up).
 * - `/help/<x>`, `/compare/<x>`, `/switch/<x>` and `/alternatives/<x>` (one segment): the English
 *   not-found page unless `<x>` is a published article, comparison, switch or alternative page.
 * - `/website-kit` in production, where the page calls `notFound()`.
 */
export function publicNotFoundPage(
  pathname: string,
  production: boolean = process.env.NODE_ENV === 'production',
): string | undefined {
  if (isArabicPublicPath(pathname)) {
    return hasArabicTwin(englishPublicPath(pathname)) ? undefined : ARABIC_NOT_FOUND_PAGE;
  }
  for (const section of ENGLISH_SLUG_SECTIONS) {
    if (!pathname.startsWith(section)) continue;
    const slug = pathname.slice(section.length);
    if (slug === '' || slug.includes('/')) return undefined;
    return hasArabicTwin(pathname) ? undefined : NOT_FOUND_PAGE;
  }
  if (production && pathname === '/website-kit') return NOT_FOUND_PAGE;
  return undefined;
}

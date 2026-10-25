import { NextResponse, type NextRequest } from 'next/server';
import { localeFromLangParam } from './lib/i18n/locale-boot';
import { LANG_REQUEST_HEADER } from './lib/i18n/locale-cookie';

/**
 * Hands an allowlisted `?lang=` to the server render (the root layout cannot see the query).
 *
 * The header is always rebuilt here: a value a client sent itself is dropped, and only `en`,
 * `ar` or an exact allowlisted tag (`locale-boot.ts`) is forwarded. Nothing else changes — no
 * cookie is set on the response, so it stays as cacheable or as private as the page made it; the
 * boot script saves the choice in the browser.
 */
export function proxy(request: NextRequest): NextResponse {
  const forwarded = new Headers(request.headers);
  forwarded.delete(LANG_REQUEST_HEADER);
  const locale = localeFromLangParam(request.nextUrl.searchParams.get('lang'));
  if (locale) forwarded.set(LANG_REQUEST_HEADER, locale);
  return NextResponse.next({ request: { headers: forwarded } });
}

export const config = {
  // Pages only: not build assets, the API rewrite, the service worker or the public files.
  matcher: ['/((?!_next/|v1/|sw.js|brand/|favicon|manifest.webmanifest|robots.txt).*)'],
};

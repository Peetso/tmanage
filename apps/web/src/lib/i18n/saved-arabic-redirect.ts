import { localeFromSearch } from './locale-boot';
import { localeFromCookieHeader } from './locale-cookie';
import { ARABIC_ROUTE_LOCALE, languageSwitchTarget } from './public-locale-routes';

/**
 * LIVEFIX (live 2026-11-18) — a visitor whose saved language is Arabic, opening a public page by
 * its English address (`/pricing`, `/sign-in`, `/verify`), is sent to the Arabic twin
 * (`/ar/pricing`) before any HTML is served.
 *
 * The English addresses are prerendered in English. The boot script (`locale-boot.ts`) set
 * `lang="ar" dir="rtl"` from the cookie before the first paint, but the Arabic words came only with
 * the catalog fetch, so for 3–5 s the visitor read English laid out right to left. The twin is
 * prerendered in Arabic, so its first paint is already right; `src/proxy.ts` answers with a 307 to
 * it.
 *
 * The same order as the boot script: a `?lang=` the address names wins over the cookie (so
 * `/pricing?lang=en` stays English and the boot script then saves English), and `?lang=` is
 * dropped from the target because the path now names the language (`languageSwitchTarget`). Only
 * the cookie counts, not `localStorage`: the server cannot see it, and the boot script copies it
 * into the cookie, so the next request is redirected. Returns `undefined` for every other request.
 */
export function savedArabicRedirect(
  pathname: string,
  search: string,
  cookieHeader: string | null | undefined,
): string | undefined {
  const wanted = localeFromSearch(search) ?? localeFromCookieHeader(cookieHeader);
  return wanted === ARABIC_ROUTE_LOCALE ? languageSwitchTarget(pathname, true, search) : undefined;
}

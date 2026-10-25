import { DISPLAY_LOCALES, type DisplayLocale } from '../api/display-preferences';

/**
 * i18n (NFR-02, live check f30af1d0) — the saved locale as a first-party cookie, so the server can
 * render `<html lang dir>`, the tab title and the first paint in the visitor's language.
 *
 * `localStorage` (`locale-boot.ts`) only reaches the browser, so the HTML used to arrive English
 * and left-to-right for everyone. The language switch now writes this cookie as well; the root
 * layout reads it (and `?lang=`, which `proxy.ts` hands over as {@link LANG_REQUEST_HEADER}).
 *
 * The cookie is a display preference, not a credential: readable by the page (not HttpOnly, so the
 * boot script and the store can agree with it), `SameSite=Lax`, one year, `Secure` on https. Its
 * value is checked against {@link DISPLAY_LOCALES} wherever it is read, so a crafted cookie can
 * never reach `dir` or a formatter. `apps/server/cache-headers.mjs` names the same cookie: a page
 * rendered for it never sits in the shared CDN cache.
 */

/** The cookie the active locale is saved under (mirrored in apps/server/cache-headers.mjs). */
export const LOCALE_COOKIE_NAME = 'tmanage_locale';

/** One year, in seconds. */
export const LOCALE_COOKIE_MAX_AGE = 31_536_000;

/** The request header `proxy.ts` puts an allowlisted `?lang=` in, for the server render. */
export const LANG_REQUEST_HEADER = 'x-tmanage-lang';

/** The locale the server renders when nothing names one. */
export const SERVER_DEFAULT_LOCALE: DisplayLocale = 'en-US';

const ALLOWED: ReadonlySet<string> = new Set(DISPLAY_LOCALES);

export function isDisplayLocale(value: unknown): value is DisplayLocale {
  return typeof value === 'string' && ALLOWED.has(value);
}

/** The allowlisted locale a raw cookie value names, or `undefined`. */
export function localeFromCookieValue(value: string | null | undefined): DisplayLocale | undefined {
  if (typeof value !== 'string' || value === '') return undefined;
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return undefined;
  }
  return isDisplayLocale(decoded) ? decoded : undefined;
}

/** The allowlisted locale in a `Cookie` header (or `document.cookie`), or `undefined`. */
export function localeFromCookieHeader(
  header: string | null | undefined,
): DisplayLocale | undefined {
  if (typeof header !== 'string' || header === '') return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== LOCALE_COOKIE_NAME) continue;
    return localeFromCookieValue(part.slice(eq + 1).trim());
  }
  return undefined;
}

/** The `document.cookie` assignment that saves `locale` (SameSite=Lax, one year, not HttpOnly). */
export function localeCookieString(locale: DisplayLocale, secure: boolean): string {
  return (
    `${LOCALE_COOKIE_NAME}=${encodeURIComponent(locale)}; Path=/; Max-Age=${LOCALE_COOKIE_MAX_AGE}; ` +
    `SameSite=Lax${secure ? '; Secure' : ''}`
  );
}

/** Save `locale` in the cookie. A browser that refuses cookies keeps the in-memory switch. */
export function writeLocaleCookie(locale: DisplayLocale): void {
  if (typeof globalThis.document === 'undefined' || !isDisplayLocale(locale)) return;
  try {
    const secure = globalThis.location?.protocol === 'https:';
    globalThis.document.cookie = localeCookieString(locale, secure);
  } catch {
    // Cookies blocked: the next load starts English from the server and the boot script corrects it.
  }
}

/** The locale saved in this browser's cookie, or `undefined`. */
export function readLocaleCookie(): DisplayLocale | undefined {
  if (typeof globalThis.document === 'undefined') return undefined;
  try {
    return localeFromCookieHeader(globalThis.document.cookie);
  } catch {
    return undefined;
  }
}

/**
 * The locale the server renders: the allowlisted `?lang=` (already resolved by `proxy.ts`), else
 * the cookie, else {@link SERVER_DEFAULT_LOCALE}. The same order the boot script and the store use.
 */
export function resolveServerLocale(input: {
  readonly lang?: string | null | undefined;
  readonly cookie?: string | null | undefined;
}): DisplayLocale {
  if (isDisplayLocale(input.lang)) return input.lang;
  return localeFromCookieValue(input.cookie) ?? SERVER_DEFAULT_LOCALE;
}

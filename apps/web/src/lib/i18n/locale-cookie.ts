import { DISPLAY_LOCALES, type DisplayLocale } from '../api/display-preferences';

/**
 * i18n (NFR-02, live check f30af1d0) — the saved locale as a first-party cookie, next to
 * `localStorage` (`locale-boot.ts`).
 *
 * The language switch writes this cookie as well as `localStorage`, and the inline boot script
 * and the store read it first. The root layout deliberately does not read it: `cookies()` there
 * would make every route dynamic and stop the public pages being prerendered and CDN-cached
 * (release no-go 70645c82), so `<html lang dir>` is still set in the browser before the first
 * paint. The cookie keeps a server-side reader possible later (a segment that is dynamic anyway).
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

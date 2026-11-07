import { DISPLAY_THEMES, type DisplayTheme } from './api/display-preferences';

/**
 * PREF-02 (B17) — the saved theme as a first-party cookie, beside `localStorage`
 * (`theme.ts`), so a server render that is dynamic anyway can put the member's
 * `data-theme` in the first HTML instead of flipping from light after the boot script
 * (`app/layout.tsx`, `lib/i18n/server-html-attributes.ts`).
 *
 * A display preference, not a credential: readable by the page, `SameSite=Lax`, one year,
 * `Secure` on https, and checked against {@link DISPLAY_THEMES} wherever it is read, so a
 * crafted value never reaches the document. Only dynamic (already `private, no-store`) pages
 * read it; prerendered pages stay light and the boot script applies the cached theme.
 */

/** The cookie the theme preference is saved under. */
export const THEME_COOKIE_NAME = 'tmanage_theme';

const THEME_COOKIE_MAX_AGE = 31_536_000;

const ALLOWED: ReadonlySet<string> = new Set(DISPLAY_THEMES);

/** The allowlisted theme a raw cookie value names, or `undefined`. */
export function themeFromCookieValue(value: string | null | undefined): DisplayTheme | undefined {
  return typeof value === 'string' && ALLOWED.has(value) ? (value as DisplayTheme) : undefined;
}

/** The `document.cookie` assignment that saves `theme`. */
export function themeCookieString(theme: DisplayTheme, secure: boolean): string {
  return (
    `${THEME_COOKIE_NAME}=${theme}; Path=/; Max-Age=${THEME_COOKIE_MAX_AGE}; ` +
    `SameSite=Lax${secure ? '; Secure' : ''}`
  );
}

/** Save `theme` in the cookie (call beside `applyTheme`). Blocked cookies keep the in-page theme. */
export function writeThemeCookie(theme: DisplayTheme): void {
  if (typeof globalThis.document === 'undefined' || themeFromCookieValue(theme) === undefined) {
    return;
  }
  try {
    const secure = globalThis.location?.protocol === 'https:';
    globalThis.document.cookie = themeCookieString(theme, secure);
  } catch {
    // Cookies blocked: the boot script still applies the cached theme before the first paint.
  }
}

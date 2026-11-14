import { workAsyncStorage } from 'next/dist/server/app-render/work-async-storage.external';
import { workUnitAsyncStorage } from 'next/dist/server/app-render/work-unit-async-storage.external';
import { THEME_COOKIE_NAME, themeFromCookieValue } from '../theme-cookie';
import { localeDirection, type TextDirection } from './direction';
import type { DisplayLocale } from '../api/display-preferences';
import type { DisplayFormat } from './display-format';
import { DISPLAY_FORMAT_COOKIE_NAME, displayFormatFromCookieValue } from './display-format-cookie';
import { LOCALE_COOKIE_NAME, localeFromCookieValue } from './locale-cookie';
import { ARABIC_PREFIX, ARABIC_ROUTE_LOCALE } from './public-locale-routes';
import { registerRequestDisplay, type RequestDisplay } from './request-display';

/**
 * B17 — `<html lang dir data-theme>` in the first HTML of a dynamic render.
 *
 * The root layout must not make prerendered pages dynamic (release no-go 70645c82: the public
 * pages stay static and CDN-cached, `deploy/hostinger/build.mjs` checks their `.html`). So the
 * request is read only when the render is a per-request one already (`workUnitAsyncStorage`'s
 * store is `type: 'request'` — a dynamic route at runtime, or `next dev`). A build-time
 * prerender gets {@link SERVER_HTML_DEFAULTS}, byte-for-byte the tag
 * `scripts/localize-prerendered-html.mjs` expects, and the boot script applies the tab's locale.
 *
 * The order follows `resolveBootLocale`: a route under `app/ar` names `ar-EG`, then the
 * saved-locale cookie. `?lang=` and the `localStorage` cache stay with the boot script.
 * Every value is allowlisted before it reaches an attribute.
 *
 * The two `next/dist/.../*.external` modules are Next's request stores (pinned `next` 16.4.2,
 * the same singletons `cookies()` uses). If a Next upgrade moves them, the guard below fails
 * closed to the defaults — the pre-B17 behaviour — rather than making every page dynamic.
 */

export type ServerHtmlAttributes = {
  readonly lang: string;
  readonly dir: TextDirection;
  readonly theme: 'light' | 'dark';
  /**
   * FIX6 locale flash: the locale and display format the page's text was rendered with (the
   * shipped default and `{}` on a prerender). The client hydrates with exactly these values.
   */
  readonly locale: DisplayLocale | undefined;
  readonly format: DisplayFormat;
};

/** What a prerendered page and a request without a saved preference get. */
export const SERVER_HTML_DEFAULTS: ServerHtmlAttributes = {
  lang: 'en',
  dir: 'ltr',
  theme: 'light',
  locale: undefined,
  format: {},
};

/** True for a route pattern under `app/ar` (`/ar`, `/ar/sign-in`, `/ar/(site)/[[...path]]`). */
function isArabicRoute(route: string | undefined): boolean {
  return (
    typeof route === 'string' && (route === ARABIC_PREFIX || route.startsWith(`${ARABIC_PREFIX}/`))
  );
}

/**
 * The attributes for a request, from its route pattern and raw cookie values. Pure, so a unit can
 * prove the order and the allowlist. `system` stays light: only the browser knows the OS scheme.
 */
export function htmlAttributesFor(input: {
  readonly route?: string | undefined;
  readonly localeCookie?: string | undefined;
  readonly themeCookie?: string | undefined;
  readonly formatCookie?: string | undefined;
}): ServerHtmlAttributes {
  const locale = isArabicRoute(input.route)
    ? ARABIC_ROUTE_LOCALE
    : localeFromCookieValue(input.localeCookie);
  const theme = themeFromCookieValue(input.themeCookie);
  return {
    lang: locale ?? SERVER_HTML_DEFAULTS.lang,
    dir: locale ? localeDirection(locale) : SERVER_HTML_DEFAULTS.dir,
    theme: theme === 'dark' ? 'dark' : SERVER_HTML_DEFAULTS.theme,
    locale,
    format: displayFormatFromCookieValue(input.formatCookie),
  };
}

/**
 * The attributes for the request being rendered, read synchronously from Next's request store
 * (its `cookies` are the same ones `cookies()` returns); `undefined` unless the render is a
 * per-request one.
 */
function currentRequestAttributes(): ServerHtmlAttributes | undefined {
  try {
    const store = workUnitAsyncStorage?.getStore?.();
    if (store?.type !== 'request') return undefined;
    return htmlAttributesFor({
      route: workAsyncStorage?.getStore?.()?.route,
      localeCookie: store.cookies.get(LOCALE_COOKIE_NAME)?.value,
      themeCookie: store.cookies.get(THEME_COOKIE_NAME)?.value,
      formatCookie: store.cookies.get(DISPLAY_FORMAT_COOKIE_NAME)?.value,
    });
  } catch {
    return undefined;
  }
}

/** The display values the shared stores read on the server (`request-display.ts`). */
function currentRequestDisplay(): RequestDisplay | undefined {
  const attributes = currentRequestAttributes();
  return attributes ? { locale: attributes.locale, format: attributes.format } : undefined;
}

registerRequestDisplay(currentRequestDisplay);

/** The attributes for the current render; the defaults unless it is a per-request render. */
export function serverHtmlAttributes(): ServerHtmlAttributes {
  return currentRequestAttributes() ?? SERVER_HTML_DEFAULTS;
}

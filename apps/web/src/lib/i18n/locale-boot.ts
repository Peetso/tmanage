import { DISPLAY_LOCALES, type DisplayLocale } from '../api/display-preferences';
import { PAGE_OWNS_TITLE, ROUTE_TITLES, TITLE_SUFFIX } from '../route-titles';
import { translate, type MessageKey } from './t';
import {
  isDisplayLocale,
  LOCALE_COOKIE_MAX_AGE,
  LOCALE_COOKIE_NAME,
  localeFromCookieHeader,
} from './locale-cookie';
import { ARABIC_PREFIX, ARABIC_ROUTE_LOCALE, isArabicPublicPath } from './public-locale-routes';
import { THEME_STORAGE_KEY } from '../theme';
import { A11Y_STORAGE_KEY } from '../a11y-shell';
import { A11Y_FONT_SCALES } from '../api/a11y-preferences';

/**
 * i18n (NFR-02, I18N-01) — the locale a tab boots in, decided before the first paint.
 *
 * The root layout reads no request (no `cookies()`/`headers()`, so the public pages stay
 * prerendered — release no-go f34db46a): every page arrives as `<html lang="en" dir="ltr">` with
 * English tab titles, and the tab's own language is applied in the browser before the first paint.
 * This module is the one place that answers "which locale does this tab start in?", and it answers
 * it twice from the same rules:
 *
 *  - {@link localeBootScript} — a tiny self-contained script `app/layout.tsx` inlines in `<head>`.
 *    It runs before the body is parsed, sets `document.documentElement.lang`/`dir`, and for an
 *    Arabic tab swaps a prerendered page's English `<title>` for its Arabic one
 *    ({@link bootTitleTable}) while the document is still parsing, so the tab never shows English.
 *  - {@link resolveBootLocale} — the same decision in TypeScript, which `LocaleStore` uses when it
 *    is constructed, so the store's client value equals what the script already painted.
 *
 * The order is: an Arabic public page's path (`/ar`, `/ar/...` — `public-locale-routes.ts`) names
 * `ar-EG` and wins, then `?lang=` (`en`, `ar`, `es`, `fr`, `pt`, `de`, `zh`, `ur`, or an exact allowlisted tag); either is persisted. Then the
 * saved-locale cookie the language switch writes, then the locale cached under
 * {@link LOCALE_STORAGE_KEY} (copied into the cookie), then nothing (the caller's default). Every
 * value is checked against {@link DISPLAY_LOCALES}, so a crafted query or cookie can never reach
 * `dir` or a formatter.
 */

/** The key the active locale is cached under, for a flash-free reload. */
export const LOCALE_STORAGE_KEY = 'tmanage:locale';

/** The short `?lang=` values a link can carry, mapped to their allowlisted locale. */
export const LANG_QUERY_ALIASES: Readonly<Record<string, DisplayLocale>> = {
  en: 'en-US',
  ar: 'ar-EG',
  // R12 R2: the beta languages, so a shared `?lang=es` link opens in that language.
  es: 'es-ES',
  fr: 'fr-FR',
  pt: 'pt-BR',
  de: 'de-DE',
  zh: 'zh-CN',
  // Slice 54-21: Urdu (right-to-left, partial catalog).
  ur: 'ur-PK',
};

/** The allowlisted locale a `?lang=` value names, or `undefined` for anything else. */
export function localeFromLangParam(value: string | null | undefined): DisplayLocale | undefined {
  if (typeof value !== 'string') return undefined;
  const key = value.toLowerCase();
  // Own keys only: `?lang=constructor` must not resolve through Object.prototype.
  if (Object.prototype.hasOwnProperty.call(LANG_QUERY_ALIASES, key)) return LANG_QUERY_ALIASES[key];
  return isDisplayLocale(value) ? value : undefined;
}

/** The allowlisted locale in a query string (`?lang=ar`), or `undefined`. */
export function localeFromSearch(search: string | null | undefined): DisplayLocale | undefined {
  if (!search) return undefined;
  try {
    return localeFromLangParam(new URLSearchParams(search).get('lang'));
  } catch {
    return undefined;
  }
}

export type BootLocale = {
  readonly locale: DisplayLocale;
  readonly fromQuery: boolean;
  /** True when the cookie does not already hold `locale`, so the caller should write it. */
  readonly saveCookie: boolean;
};

/**
 * The boot decision without side effects: `ar-EG` on an Arabic public page (`pathname`), else the
 * query's locale if it names one, else the cookie's (`cookieHeader` is `document.cookie`), else the
 * stored one if it is still allowlisted, else `undefined`. A locale the URL named (path or query)
 * comes back `fromQuery: true`, so the caller persists it.
 */
export function resolveBootLocale(
  search: string | null | undefined,
  stored: string | null | undefined,
  cookieHeader?: string | null,
  pathname?: string | null,
): BootLocale | undefined {
  const fromCookie = localeFromCookieHeader(cookieHeader);
  const fromQuery = isArabicPublicPath(pathname) ? ARABIC_ROUTE_LOCALE : localeFromSearch(search);
  if (fromQuery)
    return { locale: fromQuery, fromQuery: true, saveCookie: fromCookie !== fromQuery };
  if (fromCookie) return { locale: fromCookie, fromQuery: false, saveCookie: false };
  if (isDisplayLocale(stored)) return { locale: stored, fromQuery: false, saveCookie: true };
  return undefined;
}

/** The catalog locale the boot script's title table is written in (every `ar-*` tab uses it). */
const BOOT_TITLE_LOCALE = 'ar-EG';

/** The home page's absolute title: the brand plus its hero line (`WebsiteDocumentTitle`). */
const HOME_TITLE_PREFIX = 'TManage — ';

/**
 * English tab title → Arabic tab title, for every route without a dynamic segment (the
 * prerendered public, website and sign-in pages) plus the home page. The boot script applies it to
 * an `ar-*` tab before the first paint; `RouteDocumentTitle`/`WebsiteDocumentTitle` read it back
 * ({@link englishBootTitle}) so switching to English restores the English title. A name the
 * Arabic catalog lacks is left out, so the page keeps its English title rather than a key.
 */
export function bootTitleTable(): Readonly<Record<string, string>> {
  const table: Record<string, string> = {};
  for (const [pattern, entry] of Object.entries(ROUTE_TITLES)) {
    if (entry === PAGE_OWNS_TITLE || pattern.includes('[')) continue;
    const arabic = translate(BOOT_TITLE_LOCALE, entry.key as MessageKey);
    if (arabic === entry.key || arabic === entry.en) continue;
    table[`${entry.en}${TITLE_SUFFIX}`] = `${arabic}${TITLE_SUFFIX}`;
  }
  const heroEn = translate('en-US', 'HomePage.heroTitle');
  const heroAr = translate(BOOT_TITLE_LOCALE, 'HomePage.heroTitle');
  if (heroAr !== heroEn) table[`${HOME_TITLE_PREFIX}${heroEn}`] = `${HOME_TITLE_PREFIX}${heroAr}`;
  return table;
}

let bootTitles: Readonly<Record<string, string>> | undefined;
let bootTitlesReverse: ReadonlyMap<string, string> | undefined;

/** The English title the boot script replaced with `title`, or `undefined` if it is not one. */
export function englishBootTitle(title: string): string | undefined {
  if (bootTitlesReverse === undefined) {
    bootTitles ??= bootTitleTable();
    bootTitlesReverse = new Map(Object.entries(bootTitles).map(([en, ar]) => [ar, en]));
  }
  return bootTitlesReverse.get(title);
}

/** RTL primary subtags among the allowlist — the script needs only these, not the CLDR table. */
const RTL_PRIMARY_SUBTAGS = ['ar', 'he', 'fa', 'ur'];

/**
 * The inline `<head>` script. Plain ES5, no imports, wrapped in `try` so a browser that refuses
 * storage or lacks `URLSearchParams` just keeps the server's `en`/`ltr`. The data is embedded with
 * `JSON.stringify` and `<` is escaped, so nothing in it can close the `<script>` element. It
 * applies {@link resolveBootLocale}'s order and writes the cookie the same way `locale-cookie.ts`
 * does (SameSite=Lax, one year, Secure on https).
 */
export function localeBootScript(): string {
  const data = JSON.stringify({
    k: LOCALE_STORAGE_KEY,
    n: LOCALE_COOKIE_NAME,
    m: LOCALE_COOKIE_MAX_AGE,
    a: DISPLAY_LOCALES,
    s: LANG_QUERY_ALIASES,
    r: RTL_PRIMARY_SUBTAGS,
    t: bootTitleTable(),
    p: ARABIC_PREFIX,
    pl: ARABIC_ROUTE_LOCALE,
    th: THEME_STORAGE_KEY,
    ax: A11Y_STORAGE_KEY,
    af: A11Y_FONT_SCALES,
  }).replace(/</g, '\\u003c');
  return (
    '(function(c){try{' +
    // PREF-02: the cached theme (`lib/theme.ts`) before first paint, so dark mode never flashes.
    'try{var th=window.localStorage.getItem(c.th);if(th==="system")th=window.matchMedia&&' +
    'window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";' +
    'if(th==="dark"||th==="light")document.documentElement.setAttribute("data-theme",th);}catch(e){}' +
    'var h=document.documentElement,l=null,q=null,s=null,k=null,w=false;' +
    // x183: the cached text size, contrast and reduced motion (`lib/a11y-shell.ts`), so every
    // page, not only the settings screen, paints with them from the first frame.
    'try{var ax=JSON.parse(window.localStorage.getItem(c.ax)||"null");if(ax&&typeof ax==="object"){' +
    'if(c.af.indexOf(ax.fontScale)>-1)h.setAttribute("data-tm-font-scale",ax.fontScale);' +
    'h.setAttribute("data-tm-high-contrast",ax.highContrast===true?"on":"off");' +
    'h.setAttribute("data-tm-reduce-motion",ax.reduceMotion===true||(window.matchMedia&&' +
    'window.matchMedia("(prefers-reduced-motion: reduce)").matches)?"on":"off");}}catch(e){}' +
    'function ok(v){return typeof v==="string"&&c.a.indexOf(v)>-1;}' +
    'try{var p=document.cookie.split(";");for(var i=0;i<p.length;i++){var e=p[i].indexOf("=");' +
    'if(e>-1&&p[i].slice(0,e).trim()===c.n){' +
    'try{k=decodeURIComponent(p[i].slice(e+1).trim());}catch(x){}break;}}}catch(e){}' +
    'if(!ok(k))k=null;' +
    // An Arabic public page (`/ar`, `/ar/...`) names its locale in the path, ahead of `?lang=`.
    'var pn="";try{pn=window.location.pathname;}catch(e){}' +
    'if(pn===c.p||pn.indexOf(c.p+"/")===0){l=c.pl;}else{' +
    'try{q=new URLSearchParams(window.location.search).get("lang");}catch(e){}' +
    'if(typeof q==="string"){var lq=q.toLowerCase();' +
    'l=Object.prototype.hasOwnProperty.call(c.s,lq)?c.s[lq]:ok(q)?q:null;}}' +
    'if(l){try{window.localStorage.setItem(c.k,l);}catch(e){}w=l!==k;}' +
    'else if(k){l=k;}' +
    'else{try{s=window.localStorage.getItem(c.k);}catch(e){}if(ok(s)){l=s;w=true;}}' +
    'if(!l)return;' +
    'if(w){try{document.cookie=c.n+"="+encodeURIComponent(l)+"; Path=/; Max-Age="+c.m+' +
    '"; SameSite=Lax"+(window.location.protocol==="https:"?"; Secure":"");}catch(e){}}' +
    'h.lang=l;' +
    'var g=l.split("-")[0].toLowerCase();' +
    'h.dir=c.r.indexOf(g)>-1?"rtl":"ltr";' +
    // An Arabic tab: swap the prerendered English <title> now and while the head is still parsing
    // (the <title> may come after this script); the observer stops once the document is parsed.
    'if(g==="ar"){var f=function(){var v=document.title;' +
    'if(Object.prototype.hasOwnProperty.call(c.t,v))document.title=c.t[v];};f();' +
    'if(document.readyState==="loading"&&typeof MutationObserver==="function"){' +
    'var o=new MutationObserver(f);o.observe(h,{childList:true,subtree:true,characterData:true});' +
    'document.addEventListener("DOMContentLoaded",function(){f();o.disconnect();});}}' +
    '}catch(e){}})(' +
    data +
    ');'
  );
}

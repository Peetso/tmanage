import { DISPLAY_LOCALES, type DisplayLocale } from '../api/display-preferences';
import {
  isDisplayLocale,
  LOCALE_COOKIE_MAX_AGE,
  LOCALE_COOKIE_NAME,
  localeFromCookieHeader,
} from './locale-cookie';

/**
 * i18n (NFR-02, I18N-01) — the locale a tab boots in, decided before the first paint.
 *
 * The root layout renders `<html lang dir>` from the saved-locale cookie and `?lang=`
 * (`locale-cookie.ts`), but a browser that saved its choice only in `localStorage` (before the
 * cookie existed) or refuses cookies still gets the English baseline. This module is the one place
 * that answers "which locale does this tab start in?", and it answers it twice from the same rules:
 *
 *  - {@link localeBootScript} — a tiny self-contained script `app/layout.tsx` inlines in `<head>`.
 *    It runs before the body is parsed and sets `document.documentElement.lang`/`dir`.
 *  - {@link resolveBootLocale} — the same decision in TypeScript, which `LocaleStore` uses when it
 *    is constructed, so the store's client value equals what the script already painted.
 *
 * The order is: `?lang=` (`en`, `ar`, or an exact allowlisted tag) wins and is persisted, then the
 * saved-locale cookie (what the server rendered), then the locale cached under
 * {@link LOCALE_STORAGE_KEY} (copied into the cookie, so the next load is rendered right), then
 * nothing (the caller's default). Every value is checked against {@link DISPLAY_LOCALES}, so a
 * crafted query or cookie can never reach `dir` or a formatter.
 */

/** The key the active locale is cached under, for a flash-free reload. */
export const LOCALE_STORAGE_KEY = 'tmanage:locale';

/** The short `?lang=` values a link can carry, mapped to their allowlisted locale. */
export const LANG_QUERY_ALIASES: Readonly<Record<string, DisplayLocale>> = {
  en: 'en-US',
  ar: 'ar-EG',
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
 * The boot decision without side effects: the query's locale if it names one, else the cookie's
 * (`cookieHeader` is `document.cookie`), else the stored one if it is still allowlisted, else
 * `undefined`.
 */
export function resolveBootLocale(
  search: string | null | undefined,
  stored: string | null | undefined,
  cookieHeader?: string | null,
): BootLocale | undefined {
  const fromCookie = localeFromCookieHeader(cookieHeader);
  const fromQuery = localeFromSearch(search);
  if (fromQuery)
    return { locale: fromQuery, fromQuery: true, saveCookie: fromCookie !== fromQuery };
  if (fromCookie) return { locale: fromCookie, fromQuery: false, saveCookie: false };
  if (isDisplayLocale(stored)) return { locale: stored, fromQuery: false, saveCookie: true };
  return undefined;
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
  }).replace(/</g, '\\u003c');
  return (
    '(function(c){try{' +
    'var h=document.documentElement,l=null,q=null,s=null,k=null,w=false;' +
    'function ok(v){return typeof v==="string"&&c.a.indexOf(v)>-1;}' +
    'try{var p=document.cookie.split(";");for(var i=0;i<p.length;i++){var e=p[i].indexOf("=");' +
    'if(e>-1&&p[i].slice(0,e).trim()===c.n){' +
    'try{k=decodeURIComponent(p[i].slice(e+1).trim());}catch(x){}break;}}}catch(e){}' +
    'if(!ok(k))k=null;' +
    'try{q=new URLSearchParams(window.location.search).get("lang");}catch(e){}' +
    'if(typeof q==="string"){var lq=q.toLowerCase();' +
    'l=Object.prototype.hasOwnProperty.call(c.s,lq)?c.s[lq]:ok(q)?q:null;}' +
    'if(l){try{window.localStorage.setItem(c.k,l);}catch(e){}w=l!==k;}' +
    'else if(k){l=k;}' +
    'else{try{s=window.localStorage.getItem(c.k);}catch(e){}if(ok(s)){l=s;w=true;}}' +
    'if(!l)return;' +
    'if(w){try{document.cookie=c.n+"="+encodeURIComponent(l)+"; Path=/; Max-Age="+c.m+' +
    '"; SameSite=Lax"+(window.location.protocol==="https:"?"; Secure":"");}catch(e){}}' +
    'h.lang=l;' +
    'h.dir=c.r.indexOf(l.split("-")[0].toLowerCase())>-1?"rtl":"ltr";' +
    '}catch(e){}})(' +
    data +
    ');'
  );
}

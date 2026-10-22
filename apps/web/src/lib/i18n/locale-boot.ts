import { DISPLAY_LOCALES, type DisplayLocale } from '../api/display-preferences';

/**
 * i18n (NFR-02, I18N-01) — the locale a tab boots in, decided before the first paint.
 *
 * The pages are static (shared hosting, no `cookies()` in the root layout), so the server always
 * sends `<html lang="en" dir="ltr">`. Without help an Arabic member would see the page laid out
 * left-to-right until React hydrated, and a reload of `/resources` could even settle there. This
 * module is the one place that answers "which locale does this tab start in?", and it answers it
 * twice from the same rules:
 *
 *  - {@link localeBootScript} — a tiny self-contained script `app/layout.tsx` inlines in `<head>`.
 *    It runs before the body is parsed and sets `document.documentElement.lang`/`dir`.
 *  - {@link resolveBootLocale} — the same decision in TypeScript, which `LocaleStore` uses when it
 *    is constructed, so the store's client value equals what the script already painted.
 *
 * The order is: `?lang=` (`en`, `ar`, or an exact allowlisted tag) wins and is persisted, then the
 * locale cached under {@link LOCALE_STORAGE_KEY}, then nothing (the caller's default). Every value is
 * checked against {@link DISPLAY_LOCALES}, so a crafted query can never reach `dir` or a formatter.
 */

/** The key the active locale is cached under, for a flash-free reload. */
export const LOCALE_STORAGE_KEY = 'tmanage:locale';

/** The short `?lang=` values a link can carry, mapped to their allowlisted locale. */
export const LANG_QUERY_ALIASES: Readonly<Record<string, DisplayLocale>> = {
  en: 'en-US',
  ar: 'ar-EG',
};

const ALLOWED: ReadonlySet<string> = new Set(DISPLAY_LOCALES);

function isDisplayLocale(value: unknown): value is DisplayLocale {
  return typeof value === 'string' && ALLOWED.has(value);
}

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

export type BootLocale = { readonly locale: DisplayLocale; readonly fromQuery: boolean };

/**
 * The boot decision without side effects: the query's locale if it names one, else the stored one
 * if it is still allowlisted, else `undefined`.
 */
export function resolveBootLocale(
  search: string | null | undefined,
  stored: string | null | undefined,
): BootLocale | undefined {
  const fromQuery = localeFromSearch(search);
  if (fromQuery) return { locale: fromQuery, fromQuery: true };
  if (isDisplayLocale(stored)) return { locale: stored, fromQuery: false };
  return undefined;
}

/** RTL primary subtags among the allowlist — the script needs only these, not the CLDR table. */
const RTL_PRIMARY_SUBTAGS = ['ar', 'he', 'fa', 'ur'];

/**
 * The inline `<head>` script. Plain ES5, no imports, wrapped in `try` so a browser that refuses
 * storage or lacks `URLSearchParams` just keeps the server's `en`/`ltr`. The data is embedded with
 * `JSON.stringify` and `<` is escaped, so nothing in it can close the `<script>` element.
 */
export function localeBootScript(): string {
  const data = JSON.stringify({
    k: LOCALE_STORAGE_KEY,
    a: DISPLAY_LOCALES,
    s: LANG_QUERY_ALIASES,
    r: RTL_PRIMARY_SUBTAGS,
  }).replace(/</g, '\\u003c');
  return (
    '(function(c){try{' +
    'var h=document.documentElement,l=null,q=null,s=null;' +
    'function ok(v){return typeof v==="string"&&c.a.indexOf(v)>-1;}' +
    'try{q=new URLSearchParams(window.location.search).get("lang");}catch(e){}' +
    'if(typeof q==="string"){var lq=q.toLowerCase();' +
    'l=Object.prototype.hasOwnProperty.call(c.s,lq)?c.s[lq]:ok(q)?q:null;}' +
    'if(l){try{window.localStorage.setItem(c.k,l);}catch(e){}}' +
    'else{try{s=window.localStorage.getItem(c.k);}catch(e){}if(ok(s))l=s;}' +
    'if(!l)return;' +
    'h.lang=l;' +
    'h.dir=c.r.indexOf(l.split("-")[0].toLowerCase())>-1?"rtl":"ltr";' +
    '}catch(e){}})(' +
    data +
    ');'
  );
}

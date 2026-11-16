import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isValidElement, type ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LOCALE_STORAGE_KEY,
  localeBootScript,
  resolveBootLocale,
} from '../src/lib/i18n/locale-boot';
import {
  LOCALE_COOKIE_NAME,
  localeCookieString,
  localeFromCookieHeader,
  readLocaleCookie,
  writeLocaleCookie,
} from '../src/lib/i18n/locale-cookie';
import { SITE_DESCRIPTION_EN, siteDescription } from '../src/lib/i18n/locale-html';
import { LocaleStore } from '../src/lib/i18n/locale-store';

/**
 * Wave 6 E3 — the saved language as a cookie, after the release no-go on 70645c82.
 *
 * Guards: the language switch writes a first-party cookie; the boot script and the store read it
 * first, so nothing flips direction after load. The root layout reads no request (`cookies()` /
 * `headers()` made every route dynamic, so the public pages were no longer prerendered and
 * `deploy/hostinger/build.mjs` refused the bundle); it renders the static English baseline and the
 * browser applies the saved locale before the first paint.
 */

// Reading the request in the layout would call these; the static layout must never reach them.
const requestReads = vi.hoisted(() => ({ count: 0 }));
vi.mock('next/headers', () => ({
  cookies: async () => {
    requestReads.count += 1;
    return { get: () => undefined };
  },
  headers: async () => {
    requestReads.count += 1;
    return new Headers();
  },
}));

vi.mock('next/font/local', () => ({ default: () => ({ variable: 'font-manrope' }) }));

function clearCookie(): void {
  document.cookie = `${LOCALE_COOKIE_NAME}=; Path=/; Max-Age=0`;
}

afterEach(() => {
  clearCookie();
  window.localStorage.clear();
  window.history.replaceState(null, '', '/');
  document.documentElement.lang = 'en';
  document.documentElement.dir = 'ltr';
});

describe('the saved-locale cookie', () => {
  it('reads only an allowlisted value under its exact name', () => {
    expect(localeFromCookieHeader(`a=1; ${LOCALE_COOKIE_NAME}=ar-EG; b=2`)).toBe('ar-EG');
    expect(localeFromCookieHeader(`${LOCALE_COOKIE_NAME}=ar-EG`)).toBe('ar-EG');
    expect(localeFromCookieHeader(`${LOCALE_COOKIE_NAME}=xx-YY`)).toBeUndefined();
    expect(localeFromCookieHeader(`${LOCALE_COOKIE_NAME}=constructor`)).toBeUndefined();
    expect(localeFromCookieHeader(`${LOCALE_COOKIE_NAME}=%E0%A4%A`)).toBeUndefined();
    expect(localeFromCookieHeader(`x${LOCALE_COOKIE_NAME}=ar-EG`)).toBeUndefined();
    expect(localeFromCookieHeader('')).toBeUndefined();
    expect(localeFromCookieHeader(undefined)).toBeUndefined();
  });

  it('is SameSite=Lax, one year, site-wide, not HttpOnly, Secure only on https', () => {
    const plain = localeCookieString('ar-EG', false);
    expect(plain).toBe(`${LOCALE_COOKIE_NAME}=ar-EG; Path=/; Max-Age=31536000; SameSite=Lax`);
    expect(plain).not.toMatch(/HttpOnly/i);
    expect(localeCookieString('ar-EG', true)).toMatch(/; Secure$/);
  });

  it('is written by writeLocaleCookie and read back from document.cookie', () => {
    writeLocaleCookie('ar-EG');
    expect(readLocaleCookie()).toBe('ar-EG');
    writeLocaleCookie('en-US');
    expect(readLocaleCookie()).toBe('en-US');
  });

  it('is written whenever the store changes locale, next to localStorage', () => {
    const store = new LocaleStore('en-US');
    store.set('ar-EG');
    expect(readLocaleCookie()).toBe('ar-EG');
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('ar-EG');
  });
});

describe('the site description', () => {
  it('never shows a catalog key as the site description', () => {
    expect(siteDescription('en-US')).toBe(SITE_DESCRIPTION_EN);
    expect(siteDescription('ar-EG')).not.toMatch(/^PublicSite\./);
  });
});

const SRC = join(dirname(fileURLToPath(import.meta.url)), '../src');
const LAYOUT_SOURCE = join(SRC, 'app/layout.tsx');

describe('the root layout stays static (public pages prerendered)', () => {
  it('reads neither cookies nor headers itself (only via the request-render guard, B17)', () => {
    const source = readFileSync(LAYOUT_SOURCE, 'utf8');
    expect(source).not.toMatch(/from 'next\/headers'/);
    expect(source).not.toMatch(/server-locale/);
    expect(source).not.toMatch(/generateMetadata/);
  });

  it('renders the English left-to-right baseline the boot script corrects', async () => {
    document.cookie = `${LOCALE_COOKIE_NAME}=ar-EG; Path=/`;
    const { default: RootLayout, metadata } = await import('../src/app/layout');
    // Outside a per-request render (a build-time prerender) the layout reads no request.
    const element: unknown = await RootLayout({ children: null });
    if (!isValidElement(element)) throw new Error('RootLayout did not return an element');
    const html = element as ReactElement<{ lang: string; dir: string; 'data-theme': string }>;
    expect(html.props.lang).toBe('en');
    expect(html.props.dir).toBe('ltr');
    expect(html.props['data-theme']).toBe('light');
    expect(metadata.description).toBe(SITE_DESCRIPTION_EN);
    expect(requestReads.count).toBe(0);
  });

  it('has no request proxy left over from the server render', () => {
    expect(existsSync(LAYOUT_SOURCE)).toBe(true);
    expect(existsSync(join(SRC, 'middleware.ts'))).toBe(false);
    // 56-01's `proxy.ts` sets the CSP nonce headers; it must never pick a locale (read the
    // cookie, rewrite or redirect) — that is what the removed server-locale proxy did. Its one
    // allowed rewrite is AGENTREADY's `Accept: text/markdown` answer, which targets the page's
    // Markdown twin (`markdownPathFor`) and never a locale; it never redirects.
    const proxy = join(SRC, 'proxy.ts');
    if (existsSync(proxy)) {
      const source = readFileSync(proxy, 'utf8');
      expect(source).not.toMatch(/locale-cookie|server-locale|\.cookies\b/);
      expect(source).not.toMatch(/NextResponse\.redirect/);
      const rewrites = source.match(/NextResponse\.rewrite\([^,]*/g) ?? [];
      for (const rewrite of rewrites) {
        expect(rewrite).toMatch(/^NextResponse\.rewrite\(new URL\(markdownPathFor\(/);
      }
    }
  });
});

describe('the boot script and the store follow the cookie', () => {
  function runBootScript(): void {
    new Function(localeBootScript())();
  }

  it('prefers the cookie (what the server rendered) over localStorage', () => {
    document.cookie = `${LOCALE_COOKIE_NAME}=ar-EG; Path=/`;
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'en-US');
    runBootScript();
    expect(document.documentElement.dir).toBe('rtl');
    expect(new LocaleStore().get()).toBe('ar-EG');
  });

  it('copies a localStorage-only choice into the cookie for the next load', () => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'ar-EG');
    runBootScript();
    expect(readLocaleCookie()).toBe('ar-EG');
  });

  it('saves ?lang= in the cookie', () => {
    document.cookie = `${LOCALE_COOKIE_NAME}=ar-EG; Path=/`;
    window.history.replaceState(null, '', '/pricing?lang=en');
    runBootScript();
    expect(readLocaleCookie()).toBe('en-US');
    expect(document.documentElement.dir).toBe('ltr');
  });

  it('agrees with resolveBootLocale when a cookie is present', () => {
    for (const [search, stored, cookie] of [
      ['', 'en-US', 'ar-EG'],
      ['?lang=en', null, 'ar-EG'],
      ['', 'ar-EG', 'xx-YY'],
    ] as const) {
      clearCookie();
      window.localStorage.clear();
      if (stored) window.localStorage.setItem(LOCALE_STORAGE_KEY, stored);
      document.cookie = `${LOCALE_COOKIE_NAME}=${cookie}; Path=/`;
      window.history.replaceState(null, '', `/p${search}`);
      const expected = resolveBootLocale(search, stored, document.cookie)?.locale;
      runBootScript();
      expect(document.documentElement.lang).toBe(expected);
    }
  });
});

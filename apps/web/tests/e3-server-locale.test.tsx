import { isValidElement, type ReactElement } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { ServerLocaleProvider } from '../src/components/providers/ServerLocaleProvider';
import {
  LOCALE_STORAGE_KEY,
  localeBootScript,
  resolveBootLocale,
} from '../src/lib/i18n/locale-boot';
import {
  LANG_REQUEST_HEADER,
  LOCALE_COOKIE_NAME,
  localeCookieString,
  localeFromCookieHeader,
  readLocaleCookie,
  resolveServerLocale,
  writeLocaleCookie,
} from '../src/lib/i18n/locale-cookie';
import {
  htmlLocaleAttributes,
  SITE_DESCRIPTION_EN,
  siteDescription,
} from '../src/lib/i18n/locale-html';
import { LocaleStore } from '../src/lib/i18n/locale-store';
import { useActiveLocale } from '../src/lib/i18n/use-active-locale';
import { proxy } from '../src/proxy';

/**
 * Wave 6 E3 — server-rendered Arabic from the saved language.
 *
 * Guards: the language switch writes a first-party cookie; the server reads it (and `?lang=`) for
 * `<html lang dir>` and the first render; the boot script and the store follow the same order, so
 * nothing flips direction after load.
 */

const request = vi.hoisted(() => ({
  cookie: undefined as string | undefined,
  lang: null as string | null,
}));

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === 'tmanage_locale' && request.cookie !== undefined
        ? { name, value: request.cookie }
        : undefined,
  }),
  headers: async () => new Headers(request.lang === null ? {} : { 'x-tmanage-lang': request.lang }),
}));

vi.mock('next/font/local', () => ({ default: () => ({ variable: 'font-manrope' }) }));

function clearCookie(): void {
  document.cookie = `${LOCALE_COOKIE_NAME}=; Path=/; Max-Age=0`;
}

beforeEach(() => {
  request.cookie = undefined;
  request.lang = null;
});

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

describe('the server locale', () => {
  it('takes ?lang= first, then the cookie, then English', () => {
    expect(resolveServerLocale({ lang: 'ar-EG', cookie: 'en-US' })).toBe('ar-EG');
    expect(resolveServerLocale({ lang: null, cookie: 'ar-EG' })).toBe('ar-EG');
    expect(resolveServerLocale({ lang: 'xx', cookie: 'xx-YY' })).toBe('en-US');
    expect(resolveServerLocale({})).toBe('en-US');
  });

  it('gives <html> lang and dir for the locale', () => {
    expect(htmlLocaleAttributes('ar-EG')).toEqual({ lang: 'ar-EG', dir: 'rtl' });
    expect(htmlLocaleAttributes('en-US')).toEqual({ lang: 'en-US', dir: 'ltr' });
  });

  it('never shows a catalog key as the site description', () => {
    expect(siteDescription('en-US')).toBe(SITE_DESCRIPTION_EN);
    expect(siteDescription('ar-EG')).not.toMatch(/^PublicSite\./);
  });
});

async function renderLayout(): Promise<ReactElement<{ lang: string; dir: string }>> {
  const { default: RootLayout } = await import('../src/app/layout');
  const element = await RootLayout({ children: null });
  if (!isValidElement(element)) throw new Error('RootLayout did not return an element');
  return element as ReactElement<{ lang: string; dir: string }>;
}

describe('the root layout', () => {
  it('renders Arabic right-to-left from the cookie', async () => {
    request.cookie = 'ar-EG';
    const html = await renderLayout();
    expect(html.props.lang).toBe('ar-EG');
    expect(html.props.dir).toBe('rtl');
  });

  it('renders Arabic from ?lang=ar (the proxy header) over an English cookie', async () => {
    request.cookie = 'en-US';
    request.lang = 'ar-EG';
    const html = await renderLayout();
    expect(html.props.dir).toBe('rtl');
  });

  it('renders English left-to-right with no saved choice or a crafted cookie', async () => {
    request.cookie = '"><script>';
    const html = await renderLayout();
    expect(html.props.lang).toBe('en-US');
    expect(html.props.dir).toBe('ltr');
  });

  it('gives the client components the same locale for their first render', () => {
    function Probe() {
      return <span>{useActiveLocale(new LocaleStore('en-US'))}</span>;
    }
    const markup = renderToString(
      <ServerLocaleProvider locale="ar-EG">
        <Probe />
      </ServerLocaleProvider>,
    );
    expect(markup).toContain('ar-EG');
  });
});

describe('the proxy', () => {
  it('forwards an allowlisted ?lang= and drops a header the client sent itself', () => {
    const arabic = proxy(new NextRequest('http://localhost/pricing?lang=ar'));
    expect(arabic.headers.get(`x-middleware-request-${LANG_REQUEST_HEADER}`)).toBe('ar-EG');

    const spoofed = proxy(
      new NextRequest('http://localhost/pricing?lang=xx', {
        headers: { [LANG_REQUEST_HEADER]: 'ar-EG' },
      }),
    );
    expect(spoofed.headers.get(`x-middleware-request-${LANG_REQUEST_HEADER}`)).toBeNull();
    expect(spoofed.headers.get('set-cookie')).toBeNull();
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

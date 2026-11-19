import { afterEach, describe, expect, it } from 'vitest';
import { LOCALE_STORAGE_KEY, localeBootScript } from '../src/lib/i18n/locale-boot';
import {
  LOCALE_COOKIE_NAME,
  readLocaleCookie,
  writeLocaleCookie,
} from '../src/lib/i18n/locale-cookie';
import { arabicPageTargets, hasArabicPage } from '../src/lib/i18n/public-locale-routes';
import { savedArabicRedirect } from '../src/lib/i18n/saved-arabic-redirect';

/**
 * CDNFIX (deploy bd77e1bb, P2) — the saved-Arabic redirect also runs in the inline boot script.
 *
 * The CDN answers a cached English page without the origin and without the cookie, so the proxy's
 * 307 (`saved-arabic-redirect.ts`) never came: `/` read English laid out right to left. The boot
 * script now sends the tab to the Arabic twin from the same table the proxy's rule produces
 * (`arabicPageTargets`), and a page served in another language keeps its `lang`/`dir`.
 */

const ORIGIN = 'https://tmanageapp.com';

/** Runs the exact inline bytes against a window whose `location.replace` is recorded. */
function bootAt(href: string): string[] {
  const url = new URL(href, ORIGIN);
  const replaced: string[] = [];
  const fakeWindow = {
    localStorage: window.localStorage,
    location: {
      pathname: url.pathname,
      search: url.search,
      hash: url.hash,
      protocol: url.protocol,
      replace: (target: string) => {
        replaced.push(target);
      },
    },
  };
  new Function('window', localeBootScript())(fakeWindow);
  return replaced;
}

function clearCookie(): void {
  document.cookie = `${LOCALE_COOKIE_NAME}=; Path=/; Max-Age=0`;
}

/** The page as a prerender serves it: English, left to right. */
function servedEnglish(): void {
  document.documentElement.lang = 'en';
  document.documentElement.dir = 'ltr';
}

afterEach(() => {
  clearCookie();
  window.localStorage.clear();
  servedEnglish();
});

describe('one redirect rule for the proxy and the boot script', () => {
  it('decides every address with an Arabic page, and every query, the same way', () => {
    const targets = arabicPageTargets();
    const paths = Object.keys(targets);
    expect(paths).toEqual(expect.arrayContaining(['/', '/pricing', '/sign-in', '/verify']));
    const searches = ['', '?lang=ar', '?utm_source=ad&lang=ar&b=2', '?lang=en', '?q=a%20b'];
    for (const path of [...paths, '/projects', '/recover', '/ar', '/ar/pricing']) {
      for (const search of searches) {
        clearCookie();
        window.localStorage.clear();
        servedEnglish();
        writeLocaleCookie('ar-EG');
        const header = `${LOCALE_COOKIE_NAME}=${encodeURIComponent('ar-EG')}`;
        const proxy = savedArabicRedirect(path, search, header);
        expect(bootAt(`${path}${search}`), `${path}${search}`).toEqual(
          proxy === undefined ? [] : [proxy],
        );
      }
    }
    for (const path of paths) expect(hasArabicPage(path)).toBe(true);
  });

  it('lists only English addresses, so a twin never redirects again', () => {
    for (const [path, target] of Object.entries(arabicPageTargets())) {
      expect(path === '/ar' || path.startsWith('/ar/')).toBe(false);
      expect(target === '/ar' || target.startsWith('/ar/')).toBe(true);
      expect(savedArabicRedirect(target, '', `${LOCALE_COOKIE_NAME}=ar-EG`)).toBeUndefined();
    }
  });
});

describe('the boot script on a cached English page', () => {
  it('sends a saved ar-EG (the value the language switch writes) to the twin', () => {
    writeLocaleCookie('ar-EG');
    expect(readLocaleCookie()).toBe('ar-EG');
    expect(bootAt('/pricing?utm_source=ad#plans')).toEqual(['/ar/pricing?utm_source=ad#plans']);
    expect(bootAt('/')).toEqual(['/ar']);
    expect(bootAt('/sign-in?lang=ar&next=%2Fprojects')).toEqual(['/ar/sign-in?next=%2Fprojects']);
    // The English page is left as served while the twin loads: never English in rtl.
    expect(document.documentElement.dir).toBe('ltr');
    expect(document.documentElement.lang).toBe('en');
  });

  it('sends a localStorage-only Arabic choice too, after copying it into the cookie', () => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'ar-EG');
    expect(bootAt('/')).toEqual(['/ar']);
    expect(readLocaleCookie()).toBe('ar-EG');
  });

  it('stays when ?lang=en names English, and saves English', () => {
    writeLocaleCookie('ar-EG');
    expect(bootAt('/pricing?lang=en')).toEqual([]);
    expect(readLocaleCookie()).toBe('en-US');
    expect(document.documentElement.dir).toBe('ltr');
  });

  it('never redirects on an Arabic page', () => {
    writeLocaleCookie('ar-EG');
    document.documentElement.lang = 'ar';
    expect(bootAt('/ar')).toEqual([]);
    expect(bootAt('/ar/pricing?lang=ar')).toEqual([]);
    expect(document.documentElement.dir).toBe('rtl');
    expect(document.documentElement.lang).toBe('ar-EG');
  });

  it('keeps a page without a twin, served in English, left to right', () => {
    writeLocaleCookie('ar-EG');
    expect(bootAt('/recover')).toEqual([]);
    expect(document.documentElement.dir).toBe('ltr');
    expect(document.documentElement.lang).toBe('en');
  });

  it('ignores a bare `ar` cookie, as the proxy does (allowlist)', () => {
    document.cookie = `${LOCALE_COOKIE_NAME}=ar; Path=/`;
    expect(savedArabicRedirect('/pricing', '', `${LOCALE_COOKIE_NAME}=ar`)).toBeUndefined();
    expect(bootAt('/pricing')).toEqual([]);
    expect(document.documentElement.dir).toBe('ltr');
  });
});

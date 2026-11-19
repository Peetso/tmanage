import { render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { LocaleDirectionProvider } from '../src/components/providers/LocaleDirectionProvider';
import {
  bootTitleTable,
  englishBootTitle,
  LOCALE_STORAGE_KEY,
  localeBootScript,
  resolveBootLocale,
} from '../src/lib/i18n/locale-boot';
import { LocaleStore } from '../src/lib/i18n/locale-store';

/**
 * L12 — the locale survives a reload and `?lang=`, with no left-to-right flash.
 *
 * The regressions this guards: the static HTML coming back `dir="ltr"` English after an Arabic
 * member reloads `/resources`, `?lang=ar` being ignored, and the direction provider flipping an
 * Arabic page to `ltr` during hydration because it followed the hook's server snapshot.
 */

function runBootScript(): void {
  // The exact bytes `app/layout.tsx` inlines in `<head>`.
  new Function(localeBootScript())();
}

function resetDocument(): void {
  document.documentElement.lang = 'en';
  document.documentElement.dir = 'ltr';
}

afterEach(() => {
  window.history.replaceState(null, '', '/');
  window.localStorage.clear();
  resetDocument();
});

describe('the inline boot script', () => {
  it('sets dir=rtl and lang=ar-EG for a cached Arabic locale (a reload)', () => {
    // A page without an Arabic twin, served in Arabic (a dynamic render from the cookie).
    window.history.replaceState(null, '', '/projects');
    document.documentElement.lang = 'ar-EG';
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'ar-EG');
    runBootScript();
    expect(document.documentElement.dir).toBe('rtl');
    expect(document.documentElement.lang).toBe('ar-EG');
  });

  it('honours ?lang=ar and persists it, leaving a page served in English ltr (CDNFIX)', () => {
    window.history.replaceState(null, '', '/projects?lang=ar');
    runBootScript();
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('ar-EG');
    expect(new LocaleStore().get()).toBe('ar-EG');
    // The words on screen are still English until hydration brings the catalog.
    expect(document.documentElement.dir).toBe('ltr');
    expect(document.documentElement.lang).toBe('en');
  });

  it('ignores ?lang=xx and an off-allowlist cached value, keeping the server baseline', () => {
    window.history.replaceState(null, '', '/pricing?lang=xx');
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'xx-YY');
    runBootScript();
    expect(document.documentElement.dir).toBe('ltr');
    expect(document.documentElement.lang).toBe('en');
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('xx-YY');
  });

  it('ignores ?lang= values that name Object.prototype members', () => {
    window.history.replaceState(null, '', '/pricing?lang=constructor');
    runBootScript();
    expect(document.documentElement.lang).toBe('en');
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBeNull();
    expect(resolveBootLocale('?lang=constructor', null)).toBeUndefined();
    expect(resolveBootLocale('?lang=__proto__', null)).toBeUndefined();
  });

  it('cannot close its own <script> element', () => {
    expect(localeBootScript()).not.toMatch(/<\/script/i);
  });

  it('agrees with the store on every case it decides', () => {
    for (const [search, stored] of [
      ['?lang=ar', null],
      ['?lang=EN', 'ar-EG'],
      ['?lang=de-DE', null],
      ['', 'ar-EG'],
      ['?lang=xx', 'fr-FR'],
    ] as const) {
      window.history.replaceState(null, '', `/p${search}`);
      window.localStorage.clear();
      // The boot script saves its choice in the locale cookie too (wave 6 E3); start each case clean.
      document.cookie = 'tmanage_locale=; Path=/; Max-Age=0';
      if (stored) window.localStorage.setItem(LOCALE_STORAGE_KEY, stored);
      resetDocument();
      const expected = resolveBootLocale(search, stored)?.locale;
      // Served in the decided language (CDNFIX: a page served in another keeps its lang).
      if (expected) document.documentElement.lang = expected.split('-')[0] ?? 'en';
      runBootScript();
      expect(new LocaleStore().get()).toBe(expected);
      expect(document.documentElement.lang).toBe(expected);
    }
  });
});

describe('LocaleDirectionProvider', () => {
  it('keeps an Arabic boot rtl from mount, never flipping to ltr', () => {
    document.documentElement.dir = 'rtl';
    document.documentElement.lang = 'ar-EG';
    const store = new LocaleStore('ar-EG');

    render(
      <LocaleDirectionProvider store={store}>
        <p>x</p>
      </LocaleDirectionProvider>,
    );
    expect(document.documentElement.dir).toBe('rtl');

    store.set('en-US');
    expect(document.documentElement.dir).toBe('ltr');
    expect(document.documentElement.lang).toBe('en-US');
  });
});

describe('the boot script and the tab title (prerendered pages)', () => {
  function bootWithTitle(path: string, stored: string | null, title: string): void {
    document.cookie = 'tmanage_locale=; Path=/; Max-Age=0';
    window.history.replaceState(null, '', path);
    if (stored) window.localStorage.setItem(LOCALE_STORAGE_KEY, stored);
    document.title = title;
    runBootScript();
  }

  afterEach(() => {
    document.cookie = 'tmanage_locale=; Path=/; Max-Age=0';
    document.title = '';
  });

  it('swaps the English title for the Arabic one before hydration for an Arabic tab', () => {
    // A page without an Arabic twin (one with a twin is sent there instead, CDNFIX).
    const arabicRecover = bootTitleTable()['Recover your account · TManage'];
    expect(arabicRecover).toBeDefined();
    bootWithTitle('/recover', 'ar-EG', 'Recover your account · TManage');
    expect(document.title).toBe(arabicRecover);
    expect(englishBootTitle(document.title)).toBe('Recover your account · TManage');
  });

  it('does it for ?lang=ar too', () => {
    const arabicOffline = bootTitleTable()['Offline · TManage'];
    expect(arabicOffline).toBeDefined();
    bootWithTitle('/offline?lang=ar', null, 'Offline · TManage');
    expect(document.title).toBe(arabicOffline);
  });

  it('leaves English tabs and unknown titles alone', () => {
    bootWithTitle('/pricing', 'en-GB', 'Pricing · TManage');
    expect(document.title).toBe('Pricing · TManage');
    resetDocument();
    window.localStorage.clear();
    bootWithTitle('/resources/a', 'ar-EG', 'An article · TManage');
    expect(document.title).toBe('An article · TManage');
  });

  it('covers only routes without a dynamic segment, so the script stays small', () => {
    const table = bootTitleTable();
    expect(Object.keys(table)).not.toContain('Work · TManage');
    // CDNFIX: the table of addresses with an Arabic page (`arabicPageTargets`) is most of the rest.
    expect(localeBootScript().length).toBeLessThan(14000);
  });
});

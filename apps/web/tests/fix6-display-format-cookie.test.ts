import { afterEach, describe, expect, it } from 'vitest';
import { DisplayFormatStore } from '../src/lib/i18n/display-format';
import {
  DISPLAY_FORMAT_COOKIE_NAME,
  displayFormatCookieString,
  displayFormatFromCookieValue,
  readDisplayFormatCookie,
} from '../src/lib/i18n/display-format-cookie';
import { LOCALE_COOKIE_NAME, readLocaleCookie } from '../src/lib/i18n/locale-cookie';
import { LocaleStore } from '../src/lib/i18n/locale-store';

/**
 * FIX6 locale flash — the browser side. Changing the language or the number/date format saves it
 * at once in the cookie the next server render reads, and the application format store starts
 * from that cookie, so the browser hydrates with what the server rendered.
 */
afterEach(() => {
  document.cookie = `${LOCALE_COOKIE_NAME}=; Path=/; Max-Age=0`;
  document.cookie = `${DISPLAY_FORMAT_COOKIE_NAME}=; Path=/; Max-Age=0`;
  window.localStorage.clear();
});

describe('the saved-format cookie', () => {
  it('reads only allowlisted values', () => {
    expect(displayFormatFromCookieValue('arabic_indic.iso')).toEqual({
      numerals: 'arabic_indic',
      dateFormat: 'iso',
    });
    expect(displayFormatFromCookieValue('latin.')).toEqual({ numerals: 'latin' });
    expect(displayFormatFromCookieValue('.eu')).toEqual({ dateFormat: 'eu' });
    expect(displayFormatFromCookieValue('roman.iso')).toEqual({ dateFormat: 'iso' });
    expect(displayFormatFromCookieValue('latin.iso.x')).toEqual({});
    expect(displayFormatFromCookieValue(undefined)).toEqual({});
  });

  it('is SameSite=Lax, one year, site-wide, Secure only on https', () => {
    expect(displayFormatCookieString({ numerals: 'latin', dateFormat: 'us' }, false)).toBe(
      `${DISPLAY_FORMAT_COOKIE_NAME}=latin.us; Path=/; Max-Age=31536000; SameSite=Lax`,
    );
    expect(displayFormatCookieString({}, true)).toMatch(/; Secure$/);
  });

  it('is written when the saved format changes, and the next store boots from it', () => {
    new DisplayFormatStore(true).set({ numerals: 'arabic_indic', dateFormat: 'long' });
    expect(readDisplayFormatCookie()).toEqual({ numerals: 'arabic_indic', dateFormat: 'long' });
    expect(new DisplayFormatStore(true).get()).toEqual({
      numerals: 'arabic_indic',
      dateFormat: 'long',
    });
    expect(new DisplayFormatStore().get()).toEqual({});
  });

  it('changing the language saves it in the cookie at once', () => {
    new LocaleStore('en-US').set('ar-EG');
    expect(readLocaleCookie()).toBe('ar-EG');
  });
});

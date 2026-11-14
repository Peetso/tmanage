import { describe, expect, it } from 'vitest';
import { htmlAttributesFor } from '../src/lib/i18n/server-html-attributes';
import { applyTheme } from '../src/lib/theme';

/** B17 — a dynamic render's first `<html>` follows the `app/ar` route, then the saved cookies. */
describe('htmlAttributesFor', () => {
  it('uses the Arabic route, then an allowlisted cookie, else the static baseline', () => {
    expect(htmlAttributesFor({ route: '/ar/sign-in', localeCookie: 'en-US' })).toMatchObject({
      lang: 'ar-EG',
      dir: 'rtl',
      theme: 'light',
    });
    expect(
      htmlAttributesFor({ route: '/[orgSlug]', localeCookie: 'ar-EG', themeCookie: 'dark' }),
    ).toMatchObject({ lang: 'ar-EG', dir: 'rtl', theme: 'dark' });
    expect(
      htmlAttributesFor({ route: '/arabic', localeCookie: '"><x', themeCookie: 'system' }),
    ).toMatchObject({ lang: 'en', dir: 'ltr', theme: 'light', locale: undefined });
  });
});

describe('applyTheme', () => {
  it('saves the theme in the cookie the server render reads', () => {
    applyTheme('dark');
    expect(document.cookie).toContain('tmanage_theme=dark');
  });
});

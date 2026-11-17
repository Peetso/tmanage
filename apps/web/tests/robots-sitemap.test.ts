import { describe, expect, it } from 'vitest';
import { GET as robotsRoute } from '@/app/robots.txt/route';
import sitemap from '@/app/sitemap';
import { metadata as signInMetadata } from '@/app/sign-in/layout';
import { metadata as signUpMetadata } from '@/app/sign-up/page';
import { metadata as arabicSignInMetadata } from '@/app/ar/sign-in/page';
import { metadata as arabicSignUpMetadata } from '@/app/ar/sign-up/page';
import { ALL_RESOURCES } from '@/components/website/pages/resources/resources-data';
import { ALTERNATIVE_ENTRIES } from '@/content/alternatives/alternative-entries';
import { COMPARE_ENTRIES } from '@/content/compare/compare-entries';
import { SWITCH_ENTRIES } from '@/content/compare/switch-entries';
import { HELP_ARTICLES } from '@/content/help/help-articles';
import {
  ARABIC_AUTH_PATHS,
  arabicTwinPath,
  NOINDEX_AUTH_PATHS,
  PUBLIC_LOCALIZED_PATHS,
} from '@/lib/i18n/public-locale-routes';
import { SINGLE_LOCALE_PATHS } from '@/lib/i18n/public-single-locale';
import { absoluteSiteUrl } from '@/lib/site-origin';

describe('robots.txt and sitemap.xml (live 307 to /robots.txt/home, 2026-10-26)', () => {
  it('serves robots rules that keep only the API out and point at the sitemap', async () => {
    const body = await robotsRoute().text();
    // SOFT404: internal paths are noindex by meta tag, not advertised in robots.txt.
    expect(body.match(/^Disallow: .*$/gm)).toEqual(['Disallow: /v1/']);
    expect(body).toContain('Sitemap: https://tmanageapp.com/sitemap.xml');
  });

  it('lists every public page in English and Arabic with absolute URLs', () => {
    const urls = sitemap().map((entry) => entry.url);
    expect(urls).toEqual(
      expect.arrayContaining([
        'https://tmanageapp.com/',
        'https://tmanageapp.com/ar',
        'https://tmanageapp.com/pricing',
        'https://tmanageapp.com/ar/pricing',
      ]),
    );
    // Each indexed page with a twin in English and Arabic: the website pages, sign-up (not the
    // noindex sign-in, SEOFIX), the library articles, the Help centre and its articles (55-16),
    // the compare index and its pages (57-06), the switch pages (54-29), the alternatives index and
    // its pages and the facts page (SEOF); and each single-language
    // page once (B12). Counted from the content, so a new page does not break this test (SEOE).
    const withTwin =
      PUBLIC_LOCALIZED_PATHS.length +
      ARABIC_AUTH_PATHS.length -
      NOINDEX_AUTH_PATHS.length +
      ALL_RESOURCES.length +
      1 +
      HELP_ARTICLES.length +
      1 +
      COMPARE_ENTRIES.length +
      SWITCH_ENTRIES.length +
      1 +
      ALTERNATIVE_ENTRIES.length +
      1;
    expect(urls.length).toBe(2 * withTwin + SINGLE_LOCALE_PATHS.length);
    expect(new Set(urls).size).toBe(urls.length);
  });

  it('names no noindex page (SEOFIX: /sign-in and /ar/sign-in were listed)', () => {
    const urls = new Set(sitemap().map((entry) => entry.url));
    const robotsOf: Record<string, unknown> = {
      '/sign-in': signInMetadata.robots,
      '/ar/sign-in': arabicSignInMetadata.robots,
      '/sign-up': signUpMetadata.robots,
      '/ar/sign-up': arabicSignUpMetadata.robots,
    };
    for (const [path, robots] of Object.entries(robotsOf)) {
      const indexed =
        typeof robots === 'object' && robots !== null && 'index' in robots && robots.index === true;
      expect({ path, listed: urls.has(absoluteSiteUrl(path)) }).toEqual({ path, listed: indexed });
    }
    for (const path of NOINDEX_AUTH_PATHS) {
      expect(urls.has(absoluteSiteUrl(path))).toBe(false);
      expect(urls.has(absoluteSiteUrl(arabicTwinPath(path)))).toBe(false);
    }
  });
});

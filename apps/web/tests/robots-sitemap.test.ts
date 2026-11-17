import { describe, expect, it } from 'vitest';
import { GET as robotsRoute } from '@/app/robots.txt/route';
import sitemap from '@/app/sitemap';
import { metadata as signInMetadata } from '@/app/sign-in/layout';
import { metadata as signUpMetadata } from '@/app/sign-up/page';
import { metadata as arabicSignInMetadata } from '@/app/ar/sign-in/page';
import { metadata as arabicSignUpMetadata } from '@/app/ar/sign-up/page';
import { arabicTwinPath, NOINDEX_AUTH_PATHS } from '@/lib/i18n/public-locale-routes';
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
    // 27 website pages (A11YPAGE /accessibility, 51-10a /download, 54-17 /security/data-location, 56-17
    // /security/disclosure, 54-04 /developers), 12 library articles,
    // sign-up (not the noindex sign-in, SEOFIX), the Help centre and its 14 articles (55-16), and
    // the 57-06 compare index and its 8 pages, and the 6 switch pages (54-29) — each in English
    // and Arabic.
    expect(urls.length).toBe(140);
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

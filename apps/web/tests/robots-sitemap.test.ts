import { describe, expect, it } from 'vitest';
import { GET as robotsRoute } from '@/app/robots.txt/route';
import sitemap from '@/app/sitemap';

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
    // sign-in and sign-up, the Help centre and its 14 articles (55-16), and the 57-06 compare
    // index and its 8 pages, and the 6 switch pages (54-29) — each in English and Arabic.
    expect(urls.length).toBe(142);
  });
});

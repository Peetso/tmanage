import { describe, expect, it } from 'vitest';
import robots from '@/app/robots';
import sitemap from '@/app/sitemap';

describe('robots.txt and sitemap.xml (live 307 to /robots.txt/home, 2026-10-26)', () => {
  it('serves robots rules that keep the API out and point at the sitemap', () => {
    const result = robots();
    const rules = Array.isArray(result.rules) ? result.rules : [result.rules];
    expect(rules[0]?.disallow).toEqual(expect.arrayContaining(['/v1/', '/api/']));
    expect(result.sitemap).toBe('https://tmanage.peetrix.com/sitemap.xml');
  });

  it('lists every public page in English and Arabic with absolute URLs', () => {
    const urls = sitemap().map((entry) => entry.url);
    expect(urls).toEqual(
      expect.arrayContaining([
        'https://tmanage.peetrix.com/',
        'https://tmanage.peetrix.com/ar',
        'https://tmanage.peetrix.com/pricing',
        'https://tmanage.peetrix.com/ar/pricing',
      ]),
    );
    // 26 website pages (51-10a /download, 54-17 /security/data-location, 56-17
    // /security/disclosure, 54-04 /developers), 12 library articles,
    // sign-in and sign-up, the Help centre and its 14 articles (55-16) — each in English and Arabic.
    expect(urls.length).toBe(110);
  });
});

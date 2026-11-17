import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  changedUrls,
  indexNowPayload,
  parseArgs,
  sitemapEntries,
} from '../scripts/indexnow-ping.mjs';
import { GET as indexNowKeyRoute } from '../src/app/indexnow-key.txt/route';
import sitemap from '../src/app/sitemap';
import { PublicLocaleAlternates } from '../src/components/website/PublicLocaleAlternates';
import { indexNowKey } from '../src/lib/indexnow';
import { publicPageLanguages } from '../src/lib/i18n/public-single-locale';
import type * as SingleLocale from '../src/lib/i18n/public-single-locale';
import { DATED_PUBLIC_PATHS, pageLastModified } from '../src/lib/public-page-dates';
import { PUBLIC_PAGES, SITE_BUILD_DATE } from '../src/lib/public-pages';

let mockPathname = '/pricing';
vi.mock('next/navigation', () => ({ usePathname: () => mockPathname }));

const ARABIC_ONLY = '/ar/resources/arabic-only-example';
vi.mock('../src/lib/i18n/public-single-locale', async (importOriginal) => {
  const actual = await importOriginal<typeof SingleLocale>();
  return {
    ...actual,
    publicPageLanguages: (pathname: string | null | undefined) =>
      actual.publicPageLanguages(pathname, [ARABIC_ONLY]),
  };
});

const SITE = 'https://tmanageapp.com';

beforeEach(() => {
  vi.stubEnv('TMANAGE_SITE_URL', '');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

/** B9 (SEO plan T6): the IndexNow key route and the post-deploy ping script. */
describe('IndexNow', () => {
  it('accepts only a key of 8-128 letters, digits and dashes', () => {
    expect(indexNowKey(' abcd-1234 ')).toBe('abcd-1234');
    expect([indexNowKey(undefined), indexNowKey('short'), indexNowKey('bad key!')]).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });

  it('serves the key from the environment, and 404 while it is unset', async () => {
    vi.stubEnv('INDEXNOW_KEY', '');
    expect(indexNowKeyRoute().status).toBe(404);
    vi.stubEnv('INDEXNOW_KEY', 'a1b2c3d4e5f6');
    const response = indexNowKeyRoute();
    expect([response.status, await response.text()]).toEqual([200, 'a1b2c3d4e5f6']);
  });

  it('lists only the addresses on the site that changed on or after --since', () => {
    const xml = `<urlset>
      <url><loc>${SITE}/pricing</loc><lastmod>2026-11-17T00:00:00.000Z</lastmod></url>
      <url><loc>${SITE}/about</loc><lastmod>2026-11-09</lastmod></url>
      <url><loc>${SITE}/a?x=1&amp;y=2</loc><lastmod>2026-11-18</lastmod></url>
      <url><loc>https://elsewhere.example/</loc><lastmod>2026-11-18</lastmod></url>
      <url><loc>${SITE}/undated</loc></url>
    </urlset>`;
    expect(changedUrls(sitemapEntries(xml), '2026-11-17', SITE)).toEqual([
      `${SITE}/pricing`,
      `${SITE}/a?x=1&y=2`,
    ]);
  });

  it('names the key file as keyLocation, and refuses unknown or unsafe arguments', () => {
    expect(indexNowPayload({ site: SITE, key: 'k'.repeat(8), urls: [`${SITE}/`] })).toEqual({
      host: 'tmanageapp.com',
      key: 'kkkkkkkk',
      keyLocation: `${SITE}/indexnow-key.txt`,
      urlList: [`${SITE}/`],
    });
    expect(parseArgs(['--since', '2026-11-01'], '2026-11-17')).toEqual({
      send: false,
      since: '2026-11-01',
      site: SITE,
    });
    expect(() => parseArgs(['--sned'], '2026-11-17')).toThrow('Unknown argument');
    expect(() => parseArgs(['--since', '17/11/2026'], '2026-11-17')).toThrow('YYYY-MM-DD');
    expect(() => parseArgs(['--site', 'http://x.example'], '2026-11-17')).toThrow('https');
  });
});

/** B10 (SEO plan T5): `<lastmod>` is the day a page's words changed, the build day only if unknown. */
describe('true last-changed dates', () => {
  it('every known date is a real public page, a valid day and not in the future', () => {
    const paths = new Set(PUBLIC_PAGES.map((page) => page.path));
    const today = new Date().toISOString().slice(0, 10);
    for (const path of DATED_PUBLIC_PATHS) {
      const date = pageLastModified({ path, lastModified: SITE_BUILD_DATE });
      expect([paths.has(path), /^\d{4}-\d{2}-\d{2}$/.test(date), date <= today]).toEqual([
        true,
        true,
        true,
      ]);
    }
  });

  it('the sitemap carries the known date for both languages, and keeps the entry date otherwise', () => {
    const at = (url: string) => sitemap().find((entry) => entry.url === url)?.lastModified;
    expect([at(`${SITE}/pricing`), at(`${SITE}/ar/pricing`)]).toEqual(['2026-11-09', '2026-11-09']);
    expect(at(`${SITE}/compare/basecamp`)).toBe(
      PUBLIC_PAGES.find((page) => page.path === '/compare/basecamp')?.lastModified,
    );
  });
});

/** B12 (SEO plan 3.6): a page may exist in one language only. */
describe('single-language pages', () => {
  it('a page with a twin names both languages; an unknown path names none', () => {
    expect(publicPageLanguages('/ar/pricing')).toEqual({
      languages: { en: '/pricing', ar: '/ar/pricing' },
      xDefault: '/pricing',
    });
    expect(publicPageLanguages('/ar/not-a-page')).toBeUndefined();
  });

  it('an Arabic-only page links only to itself, never to an English page that does not exist', () => {
    mockPathname = ARABIC_ONLY;
    const html = renderToString(<PublicLocaleAlternates />);
    expect(html).toContain(`<link rel="canonical" href="${SITE}${ARABIC_ONLY}"/>`);
    expect(html).toContain(`<link rel="alternate" hrefLang="ar" href="${SITE}${ARABIC_ONLY}"/>`);
    expect(html).toContain(
      `<link rel="alternate" hrefLang="x-default" href="${SITE}${ARABIC_ONLY}"/>`,
    );
    expect(html).not.toContain('hrefLang="en"');
  });
});

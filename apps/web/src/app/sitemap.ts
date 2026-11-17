import type { MetadataRoute } from 'next';
import { NOINDEX_AUTH_PATHS } from '../lib/i18n/public-locale-routes';
import { publicPageLanguages } from '../lib/i18n/public-single-locale';
import { pageLastModified } from '../lib/public-page-dates';
import { PUBLIC_PAGES } from '../lib/public-pages';
import { absoluteSiteUrl } from '../lib/site-origin';

/**
 * `/sitemap.xml`: every indexed public page (website pages, library articles, help, compare and
 * sign-up; not the `noindex` sign-in form, SEOFIX) in each language it exists in: English and its
 * Arabic twin, each naming the other as its alternate language, or the one language of a page
 * without a twin (B12). Each carries the day its words last changed (`<lastmod>`, B10), the build
 * day only when that is unknown. Like `robots.txt`, this file keeps the address from falling
 * through to the `[orgSlug]` route.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const noindex: ReadonlySet<string> = new Set(NOINDEX_AUTH_PATHS);
  return PUBLIC_PAGES.filter((page) => !noindex.has(page.path)).flatMap((page) => {
    const lastModified = pageLastModified(page);
    const found = publicPageLanguages(page.path)?.languages ?? { en: page.path };
    const languages = Object.fromEntries(
      Object.entries(found).map(([language, path]) => [language, absoluteSiteUrl(path)]),
    );
    return Object.values(languages).map((url) => ({
      url,
      lastModified,
      alternates: { languages },
    }));
  });
}

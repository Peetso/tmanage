import type { MetadataRoute } from 'next';
import { arabicTwinPath, NOINDEX_AUTH_PATHS } from '../lib/i18n/public-locale-routes';
import { PUBLIC_PAGES } from '../lib/public-pages';
import { absoluteSiteUrl } from '../lib/site-origin';

/**
 * `/sitemap.xml`: every indexed public page (website pages, library articles, help, compare and
 * sign-up; not the `noindex` sign-in form, SEOFIX) in English and its Arabic twin, each naming the other as its alternate language and carrying the date it last
 * changed (`<lastmod>`, AGENTREADY). Like `robots.txt`, this file keeps the address from falling
 * through to the `[orgSlug]` route.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const noindex: ReadonlySet<string> = new Set(NOINDEX_AUTH_PATHS);
  return PUBLIC_PAGES.filter((page) => !noindex.has(page.path)).flatMap((page) => {
    const languages = {
      en: absoluteSiteUrl(page.path),
      ar: absoluteSiteUrl(arabicTwinPath(page.path)),
    };
    return [
      { url: languages.en, lastModified: page.lastModified, alternates: { languages } },
      { url: languages.ar, lastModified: page.lastModified, alternates: { languages } },
    ];
  });
}

import type { MetadataRoute } from 'next';
import { arabicTwinPath } from '../lib/i18n/public-locale-routes';
import { PUBLIC_PAGES } from '../lib/public-pages';
import { absoluteSiteUrl } from '../lib/site-origin';

/**
 * `/sitemap.xml`: every public website page, library article, sign-in and sign-up in English and
 * its Arabic twin, each naming the other as its alternate language and carrying the date it last
 * changed (`<lastmod>`, AGENTREADY). Like `robots.txt`, this file keeps the address from falling
 * through to the `[orgSlug]` route.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  return PUBLIC_PAGES.flatMap((page) => {
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

import type { MetadataRoute } from 'next';
import { arabicPublicPath, PUBLIC_LOCALIZED_PATHS } from '../lib/i18n/public-locale-routes';
import { siteOrigin } from '../lib/site-origin';

/**
 * `/sitemap.xml`: every public website page in English and its Arabic twin, each naming the
 * other as its alternate language. Like `robots.ts`, this file keeps the address from falling
 * through to the `[orgSlug]` redirect.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const origin = siteOrigin();
  const url = (path: string): string => (path === '/' ? `${origin}/` : `${origin}${path}`);
  return PUBLIC_LOCALIZED_PATHS.flatMap((path) => {
    const languages = { en: url(path), ar: url(arabicPublicPath(path)) };
    return [
      { url: languages.en, alternates: { languages } },
      { url: languages.ar, alternates: { languages } },
    ];
  });
}

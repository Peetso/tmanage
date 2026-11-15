import type { MetadataRoute } from 'next';
import {
  ARABIC_AUTH_PATHS,
  ARTICLE_PATHS,
  COMPARE_PATHS,
  arabicTwinPath,
  HELP_PATHS,
  PUBLIC_LOCALIZED_PATHS,
} from '../lib/i18n/public-locale-routes';
import { siteOrigin } from '../lib/site-origin';

/**
 * `/sitemap.xml`: every public website page, library article, sign-in and sign-up in English and
 * its Arabic twin, each naming the other as its alternate language. Like `robots.ts`, this file
 * keeps the address from falling through to the `[orgSlug]` redirect.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const origin = siteOrigin();
  const url = (path: string): string => (path === '/' ? `${origin}/` : `${origin}${path}`);
  return [
    ...PUBLIC_LOCALIZED_PATHS,
    ...ARTICLE_PATHS,
    ...HELP_PATHS,
    ...COMPARE_PATHS,
    ...ARABIC_AUTH_PATHS,
  ].flatMap((path) => {
    const languages = { en: url(path), ar: url(arabicTwinPath(path)) };
    return [
      { url: languages.en, alternates: { languages } },
      { url: languages.ar, alternates: { languages } },
    ];
  });
}

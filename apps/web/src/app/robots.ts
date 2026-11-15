import type { MetadataRoute } from 'next';
import { siteOrigin } from '../lib/site-origin';

/**
 * `/robots.txt`, served by Next's metadata-file convention. Without this file the address fell
 * through to the `[orgSlug]` route and redirected to `/robots.txt/home` (live, 2026-10-26).
 *
 * The public website is crawlable. Nothing else is listed (SOFT404, 2026-11-15): a disallow list
 * of internal paths only advertised them to scanners, and a disallowed page is never fetched, so
 * a crawler could not even read its `noindex`. Every page outside the public website carries
 * `<meta name="robots" content="noindex, nofollow">` from the root layout's metadata instead; only
 * the JSON API, which has no page to carry it, is kept out here.
 */
export const ROBOTS_DISALLOW = ['/v1/'] as const;

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: '*', allow: '/', disallow: [...ROBOTS_DISALLOW] }],
    sitemap: `${siteOrigin()}/sitemap.xml`,
  };
}

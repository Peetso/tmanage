import type { MetadataRoute } from 'next';
import { siteOrigin } from '../lib/site-origin';

/**
 * `/robots.txt`, served by Next's metadata-file convention. Without this file the address fell
 * through to the `[orgSlug]` route and redirected to `/robots.txt/home` (live, 2026-10-26). The
 * public website is crawlable; the API, the consent pages and the signed-in shells are not.
 */
export const ROBOTS_DISALLOW = [
  '/v1/',
  '/api/',
  '/connect/',
  '/setup',
  '/onboarding',
  '/organizations',
  '/platform',
  '/invitations',
  '/recover',
  '/sessions',
] as const;

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: '*', allow: '/', disallow: [...ROBOTS_DISALLOW] }],
    sitemap: `${siteOrigin()}/sitemap.xml`,
  };
}

import { robotsTxt } from '../../lib/site-text-files';

/**
 * `/robots.txt`. A route handler rather than Next's `robots.ts` metadata file, which cannot write
 * the `Content-Signal` line (AGENTREADY). Without it the address fell through to the `[orgSlug]`
 * route (live, 2026-10-26).
 *
 * The public website is crawlable. Nothing else is listed (SOFT404, 2026-11-15): a disallow list
 * of internal paths only advertised them to scanners, and a disallowed page is never fetched, so
 * a crawler could not even read its `noindex`. Every page outside the public website carries
 * `<meta name="robots" content="noindex, nofollow">` from the root layout's metadata instead; only
 * the JSON API, which has no page to carry it, is kept out here.
 */
export const dynamic = 'force-static';

export function GET(): Response {
  return new Response(robotsTxt(), {
    headers: { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' },
  });
}

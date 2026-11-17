import { INDEXNOW_KEY_ENV, indexNowKey } from '../../lib/indexnow';

/**
 * `/indexnow-key.txt` (SEO plan T6): the IndexNow key, which search engines fetch to check that a
 * ping really comes from this site. Read from the environment on each request, so the key is set
 * on the server and never built into the code; 404 while it is unset or malformed, so no engine
 * accepts a ping. Without this route the address would fall through to the `[orgSlug]` route.
 */
export const dynamic = 'force-dynamic';

export function GET(): Response {
  const key = indexNowKey(process.env[INDEXNOW_KEY_ENV]);
  const headers = {
    'content-type': 'text/plain; charset=utf-8',
    'x-content-type-options': 'nosniff',
  };
  return key === undefined
    ? new Response('Not found\n', { status: 404, headers })
    : new Response(key, { headers });
}

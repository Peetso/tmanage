// Pure decisions the single-process Hostinger server makes before anything else runs.
// Kept apart from server.mjs so they can be unit-tested without starting the application.

/**
 * NODE_ENV for the bundle — fail safe (pre-launch security review 2026-10-17, HIGH).
 *
 * This bundle only ever runs in production. `@tmanage/config` defaults a missing NODE_ENV to
 * `development`, which would skip every production guardrail; so a missing value is forced to
 * `production`, and any other value than `production` refuses to boot.
 *
 * @returns {{ nodeEnv: 'production', note?: string } | { error: string }}
 */
export function resolveNodeEnv(value) {
  const given = typeof value === 'string' ? value.trim() : '';
  if (given === '') {
    return { nodeEnv: 'production', note: 'NODE_ENV was not set — running as production' };
  }
  if (given === 'production') return { nodeEnv: 'production' };
  return {
    error:
      `NODE_ENV is "${given}", but this bundle only runs in production. ` +
      'Set NODE_ENV=production (or remove it) in the panel and restart.',
  };
}

/**
 * The AI connector's public, tenant-less endpoints that live outside /v1: OAuth discovery
 * metadata (RFC 9728 / RFC 8414), the OAuth authorization server, the OpenAPI description and
 * the connector download. Exact paths only, so no web page can be swallowed by a prefix.
 */
const API_EXACT_PATHS = new Set([
  '/.well-known/oauth-protected-resource',
  '/.well-known/oauth-protected-resource/mcp',
  '/.well-known/oauth-authorization-server',
  '/oauth/authorize',
  '/oauth/register',
  '/oauth/revoke',
  '/oauth/token',
  '/openapi/ai.json',
  '/downloads/tmanage-mcp.tgz',
]);

/** The paths the in-process API answers; everything else goes to the Next.js web server. */
export function isApiPath(url) {
  const path = (url ?? '').split('?')[0];
  return (
    API_EXACT_PATHS.has(path) ||
    path === '/v1' ||
    path.startsWith('/v1/') ||
    // The public site's contact form and maintenance banner live outside /v1
    // (`POST /public/site/contact`, `GET /public/site/maintenance`).
    // First-owner setup (`GET`/`POST /public/setup`), registered only while SETUP_TOKEN is set.
    path === '/public/setup' ||
    // The hosted MCP endpoint assistants connect to (`POST /mcp`, personal access token).
    path === '/mcp' ||
    path === '/public/site' ||
    path.startsWith('/public/site/')
  );
}

/** One year, the minimum the HSTS preload guidance accepts. */
export const HSTS_VALUE = 'max-age=31536000; includeSubDomains';

/**
 * Report-only first (security review §3, Low): it blocks nothing, so it cannot break a page,
 * and the browser console names whatever would be blocked before an enforcing policy ships.
 * Next.js inlines its bootstrap scripts and styles, hence 'unsafe-inline' for now.
 */
export const CSP_REPORT_ONLY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

/**
 * Headers to add to a web response: HSTS on every one, the report-only CSP on HTML. A header
 * the web server already set is kept as it is.
 */
export function webSecurityHeaders(upstreamHeaders) {
  const added = {};
  if (!('strict-transport-security' in upstreamHeaders)) {
    added['strict-transport-security'] = HSTS_VALUE;
  }
  const type = String(upstreamHeaders['content-type'] ?? '');
  if (
    type.includes('text/html') &&
    !('content-security-policy-report-only' in upstreamHeaders) &&
    !('content-security-policy' in upstreamHeaders)
  ) {
    added['content-security-policy-report-only'] = CSP_REPORT_ONLY;
  }
  return added;
}

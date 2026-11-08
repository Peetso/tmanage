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
  // C10. The deep readiness check (database, migrations, worker heartbeat, scanner) an external
  // uptime monitor polls. `/healthz` itself stays answered by server.mjs, dependency-free.
  '/healthz/deep',
]);

/**
 * The files the one process serves itself from the bundle's `downloads/` folder (Figma 409:6602):
 * the Windows desktop installer, which deploy/hostinger/build.mjs builds with electron-builder,
 * and its SHA-256, plus the AI connector bridge tarball's SHA-256. Exact paths only — nothing else under /downloads is ever read from disk, and
 * neither file is in git.
 */
export const DOWNLOADS_DIR = 'downloads';
const DOWNLOAD_FILES = new Map([
  [
    '/downloads/TManage-Setup.exe',
    { file: 'TManage-Setup.exe', contentType: 'application/octet-stream' },
  ],
  [
    '/downloads/TManage-Setup.exe.sha256',
    { file: 'TManage-Setup.exe.sha256', contentType: 'text/plain; charset=utf-8' },
  ],
  // The AI connector bridge's checksum. The tarball itself (/downloads/tmanage-mcp.tgz) is answered
  // by the API (API_EXACT_PATHS above), which reads it from this same folder by default.
  [
    '/downloads/tmanage-mcp.tgz.sha256',
    { file: 'tmanage-mcp.tgz.sha256', contentType: 'text/plain; charset=utf-8' },
  ],
]);

/**
 * The allow-listed download a URL names, or `undefined`.
 *
 * @returns {{ file: string, contentType: string } | undefined}
 */
export function downloadFor(url) {
  return DOWNLOAD_FILES.get((url ?? '').split('?')[0]);
}

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

/**
 * Two years with `includeSubDomains; preload` (56-01, r47 L2) — what the HSTS preload list asks
 * for. Submitting the host to hstspreload.org is an optional, separate step
 * (docs/runbooks/csp-enforcement.md). Same value as `HSTS_VALUE` in `apps/web/src/lib/csp.ts`,
 * which `next.config.ts` sets first; this is the fallback for a response without. HTTPS only.
 */
export const HSTS_VALUE = 'max-age=63072000; includeSubDomains; preload';

/**
 * Whether the browser reached us over HTTPS: a TLS socket, or the TLS-terminating front saying
 * so in `X-Forwarded-Proto` (first hop). A forged `https` from a plain-http client only earns it
 * an HSTS header its browser ignores over http, so the header needs no proxy trust check.
 */
export function isHttpsRequest(headers, encrypted = false) {
  if (encrypted) return true;
  const proto = String(headers?.['x-forwarded-proto'] ?? '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  return proto === 'https';
}

/**
 * Same value as `apps/web/next.config.ts` — `-allow-popups` because the OneDrive picker is a popup
 * the page opens and talks to; plain `same-origin` would sever it.
 */
export const COOP_VALUE = 'same-origin-allow-popups';

/**
 * The page's real policy is set by the web app per request, with a nonce (`apps/web/src/proxy.ts`,
 * 56-01); the old `'unsafe-inline'` report-only policy that stood in for it is gone. An HTML
 * response that arrives WITHOUT either CSP header escaped the web app's matcher, so it gets this
 * strict report-only stand-in: it blocks nothing, and every inline script on such a page shows up
 * in the `/csp-report` log, which names the path that needs fixing.
 */
export const CSP_FALLBACK_REPORT_ONLY = [
  "default-src 'self'",
  "script-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  'report-uri /csp-report',
].join('; ');

/**
 * Headers to add to a web response: HSTS on every HTTPS one; on HTML, COOP and — only when the web
 * app set no CSP of either kind — the fallback above. A header the web server already set is kept.
 */
export function webSecurityHeaders(upstreamHeaders, https = true) {
  const added = {};
  if (https && !('strict-transport-security' in upstreamHeaders)) {
    added['strict-transport-security'] = HSTS_VALUE;
  }
  const type = String(upstreamHeaders['content-type'] ?? '');
  if (!type.includes('text/html')) return added;
  if (!('cross-origin-opener-policy' in upstreamHeaders)) {
    added['cross-origin-opener-policy'] = COOP_VALUE;
  }
  if (
    !('content-security-policy-report-only' in upstreamHeaders) &&
    !('content-security-policy' in upstreamHeaders)
  ) {
    added['content-security-policy-report-only'] = CSP_FALLBACK_REPORT_ONLY;
  }
  return added;
}

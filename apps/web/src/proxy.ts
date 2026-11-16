import { join } from 'node:path';
import { NextResponse, type NextRequest } from 'next/server';
import { isEmbeddablePath, nonceFromBytes, policyHeaders, resolveCspMode } from './lib/csp';
import { bootScripts } from './lib/boot-scripts';
import { REQUEST_PATH_HEADER } from './lib/request-path';
import { createPrerenderedScriptHashes, sha256Source } from './lib/prerendered-script-hashes';
import {
  englishPublicPath,
  hasArabicTwin,
  isArabicPublicPath,
} from './lib/i18n/public-locale-routes';
import { markdownPathFor, prefersMarkdown, publicPageLinkHeader } from './lib/markdown-negotiation';
import { rememberSignupAttribution } from './lib/signup-attribution-cookie';
import { publicNotFoundPage } from './lib/public-not-found';
import { bareNotFoundRewrite, sessionHint } from './lib/workspace-gate';

/**
 * The request-time half of the browser security policy (56-01; Next 16 names this file `proxy`).
 *
 * Every page request gets a fresh 128-bit nonce. It goes on the REQUEST as `x-nonce` and inside the
 * request's CSP header — Next reads the nonce back out of that header and stamps it on each script
 * it renders — and the same policy goes on the RESPONSE. The policy itself is `lib/csp.ts`.
 *
 * A production build ENFORCES by default; `CSP_MODE=report` turns it back to report-only (the soak
 * described in `docs/runbooks/csp-enforcement.md`). `next dev` stays report-only unless
 * `CSP_MODE=enforce`. Read per request, so the flip is an environment change and a restart, not a
 * rebuild.
 *
 * The matcher leaves out what is not a page: the API (`/v1`, answered by the API itself in
 * production), the report receiver, Next's static assets and image optimiser, and any path with a
 * file extension (`/sw.js`, `/manifest.webmanifest`, `/robots.txt`, icons).
 *
 * ## Prerendered pages (read before flipping to enforce)
 *
 * A page prerendered at build time was rendered with no request, so its HTML carries no nonce.
 * `next dev` (the e2e harness) renders every page per request and cannot show this; the live
 * report-only soak can (B18: ~17 `script-src-elem` reports per page). In production such a path
 * gets the hash policy instead (`lib/prerendered-script-hashes.ts`): `'self'` plus the SHA-256 of
 * each inline script of the very HTML Next serves for it, computed at build time
 * (`scripts/write-csp-hashes.mjs`).
 */

/**
 * The two boot scripts (Trusted Types default policy, locale) never change within a process, so
 * their hashes are computed once — from the same function the root layout renders.
 */
const BOOT_SCRIPT_HASHES = bootScripts(process.env.NODE_ENV !== 'production').map(sha256Source);

/** `next start` runs with the web app as its working directory; the dist dir as next.config.ts. */
const prerenderedHashes = createPrerenderedScriptHashes(
  join(process.cwd(), process.env['TMANAGE_NEXT_DIST_DIR'] ?? '.next'),
);

export function proxy(request: NextRequest): NextResponse {
  const nonce = nonceFromBytes(crypto.getRandomValues(new Uint8Array(16)));
  const development = process.env.NODE_ENV !== 'production';
  // NOTFOUND: a signed-out bare `/{x}` is answered with the prerendered not-found page, so its
  // hash policy is that page's.
  // NEXTUP: so is an unknown public website page (`/help/<x>`, `/compare/<x>`, `/ar/...`).
  const notFoundPage =
    bareNotFoundRewrite(
      request.nextUrl.pathname,
      sessionHint((name) => request.cookies.has(name), request.headers.get('host')),
    ) ?? publicNotFoundPage(request.nextUrl.pathname);
  // `next dev` renders every page per request; a stale build's manifest must not count there.
  const pageHashes = development
    ? undefined
    : prerenderedHashes(notFoundPage ?? request.nextUrl.pathname);
  const headers = policyHeaders({
    nonce,
    mode: resolveCspMode(process.env['CSP_MODE'], !development),
    host: request.headers.get('host') ?? undefined,
    apiBaseUrl: process.env['NEXT_PUBLIC_API_BASE_URL'],
    development,
    scriptHashes: [...BOOT_SCRIPT_HASHES, ...(pageHashes ?? [])],
    prerendered: pageHashes !== undefined,
    embeddable: isEmbeddablePath(request.nextUrl.pathname),
  });

  const requestHeaders = new Headers(request.headers);
  for (const [name, value] of Object.entries(headers.request)) requestHeaders.set(name, value);
  // `set`, so a client-sent value never survives: the workspace layout redirects on it.
  requestHeaders.set(REQUEST_PATH_HEADER, request.nextUrl.pathname);
  const response =
    notFoundPage === undefined
      ? publicPageResponse(request, requestHeaders)
      : NextResponse.rewrite(new URL(notFoundPage, request.url), {
          status: 404,
          request: { headers: requestHeaders },
        });
  // `append`: in report-only mode `content-security-policy` carries the enforced frame-ancestors
  // stand-in; appending never overwrites a header Next or next.config.ts already set.
  for (const [name, value] of headers.response) response.headers.append(name, value);
  return response;
}

/**
 * A public page (one in the sitemap, English or Arabic) names its Markdown version and
 * `llms.txt` in a `Link` header, and varies by `Accept` (AGENTREADY): an English page asked for
 * `text/markdown` is answered with its Markdown version (`app/md`) at the same address, and a
 * landing from an ad keeps its `utm_*` values for sign-up (ADTRACK). Any other
 * request goes on unchanged.
 */
function publicPageResponse(request: NextRequest, requestHeaders: Headers): NextResponse {
  const pathname = request.nextUrl.pathname;
  const english = englishPublicPath(pathname);
  if (!hasArabicTwin(english)) return NextResponse.next({ request: { headers: requestHeaders } });
  const response =
    !isArabicPublicPath(pathname) && prefersMarkdown(request.headers.get('accept'))
      ? NextResponse.rewrite(new URL(markdownPathFor(english), request.url), {
          request: { headers: requestHeaders },
        })
      : NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.append('vary', 'Accept');
  response.headers.set('link', publicPageLinkHeader(english));
  rememberSignupAttribution(request, response);
  return response;
}

export const config = {
  matcher: [
    // `[.]`, not `\\.`: path-to-regexp drops the backslash, and a bare `.` would match every path.
    '/((?!v1(?:/|$)|csp-report$|_next/static|_next/image|.*[.][A-Za-z0-9]+$).*)',
  ],
};

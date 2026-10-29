import { createHash } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { nonceFromBytes, policyHeaders, resolveCspMode } from './lib/csp';
import { localeBootScript } from './lib/i18n/locale-boot';

/**
 * The request-time half of the browser security policy (56-01; Next 16 names this file `proxy`).
 *
 * Every page request gets a fresh 128-bit nonce. It goes on the REQUEST as `x-nonce` and inside the
 * request's CSP header — Next reads the nonce back out of that header and stamps it on each script
 * it renders — and the same policy goes on the RESPONSE. The policy itself is `lib/csp.ts`.
 *
 * `CSP_MODE=enforce` enforces; the default is report-only, for the 7-day live soak described in
 * `docs/runbooks/csp-enforcement.md`. Read per request, so the flip is an environment change and a
 * restart, not a rebuild.
 *
 * The matcher leaves out what is not a page: the API (`/v1`, answered by the API itself in
 * production), the report receiver, Next's static assets and image optimiser, and any path with a
 * file extension (`/sw.js`, `/manifest.webmanifest`, `/robots.txt`, icons).
 *
 * ## Prerendered pages (read before flipping to enforce)
 *
 * A page prerendered at build time was rendered with no request, so its HTML carries no nonce.
 * `next dev` (the e2e harness) renders every page per request and cannot show this; the live
 * report-only soak can, and the runbook says what to do about it before enforcing.
 */

/** The locale boot script never changes within a build, so its hash is computed once. */
const BOOT_SCRIPT_HASH = `sha256-${createHash('sha256').update(localeBootScript()).digest('base64')}`;

export function proxy(request: NextRequest): NextResponse {
  const nonce = nonceFromBytes(crypto.getRandomValues(new Uint8Array(16)));
  const headers = policyHeaders({
    nonce,
    mode: resolveCspMode(process.env['CSP_MODE']),
    host: request.headers.get('host') ?? undefined,
    apiBaseUrl: process.env['NEXT_PUBLIC_API_BASE_URL'],
    development: process.env.NODE_ENV !== 'production',
    scriptHashes: [BOOT_SCRIPT_HASH],
  });

  const requestHeaders = new Headers(request.headers);
  for (const [name, value] of Object.entries(headers.request)) requestHeaders.set(name, value);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  // `append`: the report-only header carries two policies (the page's and Trusted Types'); a
  // comma-joined value is the standard way to send several policies in one header.
  for (const [name, value] of headers.response) response.headers.append(name, value);
  return response;
}

export const config = {
  matcher: [
    // `[.]`, not `\\.`: path-to-regexp drops the backslash, and a bare `.` would match every path.
    '/((?!v1(?:/|$)|csp-report$|_next/static|_next/image|.*[.][A-Za-z0-9]+$).*)',
  ],
};

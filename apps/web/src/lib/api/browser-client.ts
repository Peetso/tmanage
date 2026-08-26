import { ApiClient, newCorrelationId, readCookie } from './client';

/**
 * The `ApiClient` a browser gets.
 *
 * Split from `client.ts` so that the client itself has no globals in it: `client.ts` takes
 * `fetch`, the cookie reader and the ID source as parameters and can therefore be tested
 * without a DOM, while everything that reaches for `window` or `process.env` is gathered
 * here where it is obvious.
 *
 * Both settings are `NEXT_PUBLIC_` because both are read in the browser. Neither is a
 * secret: the API origin is visible in every network request, and the CSRF cookie *name* is
 * visible in every `Set-Cookie`. The values that are secret — `SESSION_SECRET`,
 * `CSRF_SECRET` — stay in the API and are never referenced here.
 */

/**
 * Defaults matched to `.env.example` in the API. A missing variable is a misconfiguration,
 * but it is a misconfiguration that should surface as "cannot reach the API" during local
 * work rather than as a crash at import time in a production build.
 */
const DEFAULT_API_BASE_URL = 'http://localhost:3001';
const DEFAULT_CSRF_COOKIE_NAME = 'tm_session_csrf';

export function apiBaseUrl(): string {
  const configured = process.env['NEXT_PUBLIC_API_BASE_URL'];
  const value = configured && configured !== '' ? configured : DEFAULT_API_BASE_URL;
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

export function csrfCookieName(): string {
  const configured = process.env['NEXT_PUBLIC_SESSION_COOKIE_NAME'];
  return configured && configured !== '' ? `${configured}_csrf` : DEFAULT_CSRF_COOKIE_NAME;
}

let cached: ApiClient | undefined;

/**
 * The process-wide client.
 *
 * Cached because `ApiClient` holds no per-request state and constructing one per render
 * would make it useless as a dependency to assert on. Tests build their own instance with
 * their own `fetch` rather than reaching for this.
 */
export function browserApiClient(): ApiClient {
  if (cached) return cached;

  const cookieName = csrfCookieName();
  cached = new ApiClient({
    baseUrl: apiBaseUrl(),
    csrfCookieName: cookieName,
    fetch: (...args) => globalThis.fetch(...args),
    readCsrfToken: () =>
      typeof document === 'undefined' ? undefined : readCookie(document.cookie, cookieName),
    newCorrelationId,
  });
  return cached;
}

/** Test seam: drop the cached instance so a changed environment is picked up. */
export function resetBrowserApiClient(): void {
  cached = undefined;
}

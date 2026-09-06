import { ApiClient, newCorrelationId, readCookie } from './client';
import { authBoundary } from '../auth-boundary';
import { resolveApiBaseUrl, resolveCsrfCookieName } from '../public-config';

/**
 * The `ApiClient` a browser gets.
 *
 * Split from `client.ts` so that the client itself has no globals in it: `client.ts` takes
 * `fetch`, the cookie reader and the ID source as parameters and can therefore be tested
 * without a DOM, while everything that reaches for `window`, `navigator` or `process.env` is
 * gathered here where it is obvious.
 *
 * Both settings are `NEXT_PUBLIC_` because both are read in the browser. Neither is a
 * secret: the API origin is visible in every network request, and the CSRF cookie *name* is
 * visible in every `Set-Cookie`. The values that are secret — `SESSION_SECRET`,
 * `CSRF_SECRET` — stay in the API and are never referenced here.
 *
 * The rules for the two values live in `public-config.ts`, shared with `next.config.ts`, which
 * refuses a production build that would end up here without them (review finding D19). The
 * `process.env` reads stay in this file, spelled out, because Next inlines only a
 * `process.env.NEXT_PUBLIC_*` it can see literally.
 */

export function apiBaseUrl(): string {
  return resolveApiBaseUrl({
    nodeEnv: process.env.NODE_ENV,
    apiBaseUrl: process.env['NEXT_PUBLIC_API_BASE_URL'],
    sessionCookieName: process.env['NEXT_PUBLIC_SESSION_COOKIE_NAME'],
  });
}

export function csrfCookieName(): string {
  return resolveCsrfCookieName({
    nodeEnv: process.env.NODE_ENV,
    apiBaseUrl: process.env['NEXT_PUBLIC_API_BASE_URL'],
    sessionCookieName: process.env['NEXT_PUBLIC_SESSION_COOKIE_NAME'],
  });
}

/** The name every tab of this origin takes the refresh lock under. */
const REFRESH_LOCK = 'tmanage-session-refresh';

/**
 * `navigator.locks` where the browser has it (every current engine does); direct execution
 * where it does not — server rendering, and jsdom. With the lock, two tabs that both find
 * their access token expired refresh one after the other, and the second one presents the
 * *rotated* cookie rather than the one the first just spent.
 */
async function crossTabLock<T>(work: () => Promise<T>): Promise<T> {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
  if (!locks) return work();
  // `LockManager.request` is typed as resolving to `any`; the value is `work`'s own.
  return (await locks.request(REFRESH_LOCK, work)) as T;
}

let cached: ApiClient | undefined;

/**
 * The process-wide client.
 *
 * Cached because `ApiClient` holds no per-request state that a screen should see, and
 * constructing one per render would make it useless as a dependency to assert on. It does
 * hold the CSRF token the API returned to this tab, which is exactly why there must be one:
 * a token remembered by one instance and read by another is a token nobody has. Tests build
 * their own instance with their own `fetch` rather than reaching for this.
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
    recovery: {
      lock: crossTabLock,
      // The client knows the session is over; the boundary knows what follows — every tab
      // clears its caches and this one goes to sign-in (`AuthBoundaryProvider`).
      onSessionEnded: () => authBoundary.announce('session-ended'),
    },
  });
  return cached;
}

/**
 * The token in memory belongs to one session. Any change of principal — this tab's sign-out,
 * another tab's sign-in, a session the API ended — makes it wrong, so it is forgotten on every
 * notice except this tab's own sign-in, which has just stored the new one.
 */
authBoundary.subscribe(({ event, origin }) => {
  if (event === 'signed-in' && origin === 'local') return;
  cached?.forgetCsrfToken();
});

/** Test seam: drop the cached instance so a changed environment is picked up. */
export function resetBrowserApiClient(): void {
  cached = undefined;
}

/**
 * The web application's public configuration — resolved in one place, validated at build time.
 *
 * ## Why (review findings D02, D03 and D19, 2026-09-05)
 *
 * Three defects shared one cause: the browser's settings were read in three places with
 * three sets of assumptions.
 *
 * - **D02.** The browser defaulted its CSRF cookie name to `tm_session_csrf`; the API and
 *   `.env.example` default to `tmanage_session`, so the readable cookie is
 *   `tmanage_session_csrf`. A deployment that followed the documented defaults could not find
 *   the token and every mutation was refused. The E2E stack set the override explicitly, which
 *   is why the suite was green. The default now comes from `DEFAULT_SESSION_COOKIE_NAME`, the
 *   same value `packages/config` uses, and a test holds the two equal.
 * - **D03.** Cookies are host-only. With the web app on one host and the API on another, the
 *   API's readable CSRF cookie is invisible to the web page's script, and so is any refresh
 *   the page would like to make. `50-BOOTSTRAP` §3 deploys the two as two Node applications,
 *   which on the target host means two hostnames — the exact seam. The supported production
 *   topology is therefore **same-origin through the web application**: the browser talks only
 *   to the web origin, and Next.js rewrites `/v1/*` to the API (`API_PROXY_TARGET`). The two
 *   applications stay two applications; the browser sees one. `NEXT_PUBLIC_API_BASE_URL` is
 *   set to the literal `same-origin` to choose it.
 * - **D19.** A missing `NEXT_PUBLIC_API_BASE_URL` silently became `http://localhost:3001` in a
 *   production build. The default stays for development, where it is convenient and correct;
 *   a production build with the variable absent, insecure, or pointing at a loopback address
 *   now fails inside `next build` with a sentence that names the variable.
 *
 * ## Two readers, one resolver
 *
 * `next.config.ts` calls `validatePublicConfigForBuild` with the build's environment; the
 * browser client calls `resolveApiBaseUrl` / `resolveCsrfCookieName` with the values Next
 * inlined. Next only inlines a `process.env.NEXT_PUBLIC_*` reference it can see literally, so
 * the browser side reads the variables itself and passes the strings here rather than passing
 * `process.env`. The rules live here; the reads stay where the bundler can find them.
 *
 * Nothing in this module is a secret. The API origin is in every network request and the
 * cookie *name* is in every `Set-Cookie`.
 */

/** The development default. Matches `apps/api`'s `.env.example` port. */
export const DEVELOPMENT_API_BASE_URL = 'http://localhost:3001';

/**
 * The value of `NEXT_PUBLIC_API_BASE_URL` that selects the same-origin topology. A word rather
 * than an empty string, because an empty string is indistinguishable from "forgot to set it",
 * and D19 is precisely about that being fatal in production.
 */
export const SAME_ORIGIN = 'same-origin';

/**
 * `packages/config`'s `SESSION_COOKIE_NAME` default. Duplicated here on purpose rather than
 * imported: `@tmanage/config` is the API's environment loader and has no place in a browser
 * bundle. `tests/public-config.test.ts` imports both and holds them equal.
 */
export const DEFAULT_SESSION_COOKIE_NAME = 'tmanage_session';

/** The path prefix every API route lives under, and therefore the one the proxy forwards. */
export const API_PATH_PREFIX = '/v1';

export interface PublicEnvironment {
  /** `NODE_ENV`. Next sets `production` for `next build` and `next start`. */
  readonly nodeEnv: string | undefined;
  /** `NEXT_PUBLIC_API_BASE_URL`. */
  readonly apiBaseUrl: string | undefined;
  /** `NEXT_PUBLIC_SESSION_COOKIE_NAME`. */
  readonly sessionCookieName: string | undefined;
  /**
   * `API_PROXY_TARGET` — server-side only, never `NEXT_PUBLIC_`. The API's origin as the web
   * server reaches it when `NEXT_PUBLIC_API_BASE_URL` is `same-origin`; plain http is
   * accepted in production only for a loopback address. Not read in the browser, which is
   * why it is optional here.
   */
  readonly apiProxyTarget?: string | undefined;
}

/**
 * A configuration the build must not proceed with. The message is the whole diagnosis: it
 * names the variable, says what was found, and says what would be accepted.
 */
export class PublicConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PublicConfigError';
  }
}

function isProduction(env: PublicEnvironment): boolean {
  return env.nodeEnv === 'production';
}

function trimmed(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text === undefined || text === '' ? undefined : text;
}

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]', '0.0.0.0']);

function isLoopback(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname) || hostname.endsWith('.localhost');
}

/**
 * Parse an origin, refusing anything that is not one.
 *
 * A path, query or fragment on the API base is a mistake that surfaces as "every request is
 * 404" — `${baseUrl}${path}` would produce `https://api.example/api/v1/...` against an API
 * that answers at `/v1`. It is refused here instead.
 *
 * The production rules differ by who dials. The browser's origin (`NEXT_PUBLIC_API_BASE_URL`)
 * must be https and must not be loopback — a loopback compiled into the bundle dials the
 * reader's own machine (D19). The web server's target (`API_PROXY_TARGET`) is a hop on the
 * deployment's own network: a loopback there is the API on the same machine, the ordinary
 * case, and plain http is safe precisely there and nowhere else. The first live `next build`
 * witness (2026-09-06) found the two held to one rule, which refused the value
 * `.env.example` itself documents.
 */
function parseOrigin(
  variable: string,
  value: string,
  production: boolean,
  reachedFrom: 'browser' | 'server' = 'browser',
): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PublicConfigError(
      `${variable} is "${value}", which is not an absolute URL. Set it to the API's origin, such as https://api.example.com, or to "${SAME_ORIGIN}".`,
    );
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new PublicConfigError(
      `${variable} is "${value}"; only http and https origins are accepted.`,
    );
  }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new PublicConfigError(
      `${variable} is "${value}"; give the origin only — the API's routes already begin with ${API_PATH_PREFIX}.`,
    );
  }
  if (!production) return url.origin;

  if (reachedFrom === 'server') {
    // The web server's own hop to the API. Plain http is acceptable exactly when it never
    // leaves the machine; anything that crosses a network carries the session cookies and
    // must be https.
    if (url.protocol !== 'https:' && !isLoopback(url.hostname)) {
      throw new PublicConfigError(
        `${variable} is "${value}"; a production web server must reach an API on another host over https. Plain http is accepted only for a loopback address (the API on this machine).`,
      );
    }
    return url.origin;
  }

  if (url.protocol !== 'https:') {
    throw new PublicConfigError(
      `${variable} is "${value}"; a production build must use https, or "${SAME_ORIGIN}" with API_PROXY_TARGET.`,
    );
  }
  if (isLoopback(url.hostname)) {
    throw new PublicConfigError(
      `${variable} is "${value}", a loopback address. A production build would dial the reader's own machine. Set the deployed API origin, or "${SAME_ORIGIN}" with API_PROXY_TARGET.`,
    );
  }

  return url.origin;
}

/**
 * The base every API request is built on: an absolute origin without a trailing slash, or the
 * empty string when the API is reached through this origin.
 */
export function resolveApiBaseUrl(env: PublicEnvironment): string {
  const production = isProduction(env);
  const configured = trimmed(env.apiBaseUrl);

  if (configured === undefined) {
    if (production) {
      throw new PublicConfigError(
        `NEXT_PUBLIC_API_BASE_URL is not set. A production build has no safe default: set it to "${SAME_ORIGIN}" (and API_PROXY_TARGET to the API's origin) or to the API's https origin.`,
      );
    }
    return DEVELOPMENT_API_BASE_URL;
  }

  if (configured === SAME_ORIGIN) return '';

  return parseOrigin('NEXT_PUBLIC_API_BASE_URL', configured, production);
}

/**
 * The readable CSRF cookie's name, derived exactly as the API derives it:
 * `${SESSION_COOKIE_NAME}_csrf` (`apiConfigFrom` in `apps/api`).
 */
export function resolveCsrfCookieName(env: PublicEnvironment): string {
  const configured = trimmed(env.sessionCookieName) ?? DEFAULT_SESSION_COOKIE_NAME;
  return `${configured}_csrf`;
}

export interface ApiRewrite {
  readonly source: string;
  readonly destination: string;
}

/**
 * The rewrites that make the API same-origin, or none.
 *
 * `source` and `destination` carry the identical `/v1/:path*`, and that identity is
 * load-bearing: the API scopes its refresh cookie to `Path=/v1/sessions/refresh`. A prefix
 * such as `/api/v1` on the browser side would leave the browser holding a refresh cookie for
 * a path it never requests, and every refresh would be refused for want of a cookie that is
 * right there.
 */
export function resolveApiRewrites(env: PublicEnvironment): readonly ApiRewrite[] {
  const production = isProduction(env);
  const configured = trimmed(env.apiBaseUrl);
  const target = trimmed(env.apiProxyTarget);

  if (configured !== SAME_ORIGIN) {
    if (target !== undefined) {
      throw new PublicConfigError(
        `API_PROXY_TARGET is set but NEXT_PUBLIC_API_BASE_URL is ${
          configured === undefined ? 'not set' : `"${configured}"`
        }. The proxy is only used when NEXT_PUBLIC_API_BASE_URL is "${SAME_ORIGIN}"; set both or neither.`,
      );
    }
    return [];
  }

  if (target === undefined) {
    throw new PublicConfigError(
      `NEXT_PUBLIC_API_BASE_URL is "${SAME_ORIGIN}" but API_PROXY_TARGET is not set. The web server needs the API's origin to forward ${API_PATH_PREFIX}/* to.`,
    );
  }

  const origin = parseOrigin('API_PROXY_TARGET', target, production, 'server');
  return [
    { source: `${API_PATH_PREFIX}/:path*`, destination: `${origin}${API_PATH_PREFIX}/:path*` },
  ];
}

export interface ValidatedPublicConfig {
  readonly apiBaseUrl: string;
  readonly csrfCookieName: string;
  readonly rewrites: readonly ApiRewrite[];
}

/**
 * Everything `next.config.ts` needs, or a `PublicConfigError` that stops the build.
 *
 * Called at configuration load, which is before any route compiles, so a misconfigured
 * production build fails in its first second with a message rather than in its last minute
 * with a bundle that dials localhost.
 */
export function validatePublicConfigForBuild(env: PublicEnvironment): ValidatedPublicConfig {
  return {
    apiBaseUrl: resolveApiBaseUrl(env),
    csrfCookieName: resolveCsrfCookieName(env),
    rewrites: resolveApiRewrites(env),
  };
}

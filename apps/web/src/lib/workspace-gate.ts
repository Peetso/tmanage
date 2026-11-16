import { isAddressableWorkspaceSlug } from '@tmanage/domain';
import { resolveApiBaseUrl, resolveCsrfCookieName } from './public-config';
import { signInPathFor } from './sign-in-return';

/**
 * What the server does with a request for a workspace address (`/{slug}/…`), before any screen
 * renders (SOFT404, 2026-11-15).
 *
 * Every first path segment no static route claims lands in `[orgSlug]`. Before this, a scanner's
 * `/wp-admin`, `/debug` or `/elmah.axd` was redirected to `/{x}/home` and answered 200 with the
 * signed-in shell, so outside scanners reported "WordPress admin exposed" and the like.
 *
 * - A segment that is not a workspace address — wrong shape (`elmah.axd`, `_debug`) or reserved
 *   (`wp-admin`, `server-status`, `api`) — is a real 404.
 * - A signed-out request for the bare `/{x}` is a 404 too, for every `x` (AGENTREADY, 2026-11-16):
 *   `/this-page-does-not-exist` no longer ends on the sign-in page with 200.
 * - Any deeper signed-out address goes to sign-in, keeping only an allowed return path
 *   (`signInPathFor`), or to the portal's own sign-in for a portal address. The portal sign-in
 *   page itself stays open: that is where a signed-out client asks for a link.
 * - Otherwise the screen renders; membership is the API's answer, as before.
 *
 * `hasSession` is the readable CSRF cookie being present. It is a routing hint, not a
 * credential: a forged one only shows the shell, which reads nothing without a session the API
 * accepts.
 */
export type WorkspaceGate =
  | { readonly kind: 'not-found' }
  | { readonly kind: 'sign-in'; readonly location: string }
  | { readonly kind: 'open' };

export interface WorkspaceRequest {
  /** The `[orgSlug]` route parameter. */
  readonly slug: string;
  /** The request path, when known; anything not under `/{slug}` is ignored. */
  readonly pathname: string | null;
  readonly hasSession: boolean;
}

export function workspaceGate({ slug, pathname, hasSession }: WorkspaceRequest): WorkspaceGate {
  if (!isAddressableWorkspaceSlug(slug)) return { kind: 'not-found' };
  if (hasSession) return { kind: 'open' };

  const root = `/${slug}`;
  // A signed-out bare `/{x}` is a 404 whether or not a workspace has that address (AGENTREADY):
  // an unknown page is a real 404 for crawlers, and no lookup tells a visitor which slugs exist.
  if (pathname === root) return { kind: 'not-found' };
  const here =
    pathname !== null && (pathname === root || pathname.startsWith(`${root}/`)) ? pathname : root;
  const portalSignIn = `${root}/portal/sign-in`;
  if (here === portalSignIn) return { kind: 'open' };
  if (here === `${root}/portal` || here.startsWith(`${root}/portal/`)) {
    return { kind: 'sign-in', location: portalSignIn };
  }
  return { kind: 'sign-in', location: signInPathFor(here) };
}

/**
 * The routing hint `hasSession` for a request: the readable CSRF cookie is present, or this web
 * server cannot see the session's cookies at all (then the client-side boundary decides).
 */
export function sessionHint(
  hasCookie: (name: string) => boolean,
  host: string | null,
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const environment = {
    nodeEnv: env['NODE_ENV'],
    apiBaseUrl: env['NEXT_PUBLIC_API_BASE_URL'],
    sessionCookieName: env['NEXT_PUBLIC_SESSION_COOKIE_NAME'],
  };
  return (
    hasCookie(resolveCsrfCookieName(environment)) ||
    !sessionCookieVisible(resolveApiBaseUrl(environment), host)
  );
}

/**
 * The static not-found page a signed-out request for a bare `/{x}` is answered with, or
 * `undefined` (NOTFOUND, live 2026-11-16). The `[orgSlug]` layout's `notFound()` reaches the
 * browser as a 404 with an EMPTY body (Next streams the not-found screen as client-only data, and
 * the page's Trusted Types policy keeps it from drawing), so the proxy answers these with the
 * prerendered `/_not-found` HTML instead: the full screen, "Back to home" and "Sign in", status
 * 404. Every such `/{x}` gets it, a workspace address or not, so nothing tells which exist.
 */
export const NOT_FOUND_PAGE = '/_not-found';

export function bareNotFoundRewrite(pathname: string, hasSession: boolean): string | undefined {
  const slug = /^\/([^/]+)$/.exec(pathname)?.[1];
  // Only an address `[orgSlug]` would take: every static top-level route is a reserved word, so
  // `/pricing` or `/sign-in` never match, and a scanner word keeps the layout's plain 404.
  if (slug === undefined || hasSession || !isAddressableWorkspaceSlug(slug)) return undefined;
  return NOT_FOUND_PAGE;
}

/**
 * Whether this web server can see the session's readable cookie at all. It can when the API is
 * same-origin (production: the `/v1` rewrite) or on the same host name (development: another
 * port of `localhost`; cookies ignore ports). An API on another host keeps its cookies there,
 * and then the client-side auth boundary stays the only sign-in redirect.
 */
export function sessionCookieVisible(apiBaseUrl: string, host: string | null): boolean {
  if (apiBaseUrl === '') return true;
  if (host === null) return false;
  try {
    return new URL(apiBaseUrl).hostname === new URL(`http://${host}`).hostname;
  } catch {
    return false;
  }
}

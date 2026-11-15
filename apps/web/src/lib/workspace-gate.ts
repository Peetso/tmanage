import { isAddressableWorkspaceSlug } from '@tmanage/domain';
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
 * - A signed-out visitor goes to sign-in, keeping only an allowed return path
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

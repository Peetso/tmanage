import { createHash, createHmac, randomBytes } from 'node:crypto';
import {
  constantTimeEquals,
  expireCookie,
  readCookie,
  serializeCookie,
} from '../../modules/identity/session-token.js';

/**
 * The one sign-in helper behind every one-click Connect (Figma, GitHub). Each provider keeps its
 * own flow shape, cookie name and HMAC purpose; the checks live here once:
 *
 * 1. `start` seals a short-lived flow (state, optional PKCE verifier, workspace, member) into an
 *    HttpOnly, `SameSite=Lax` cookie on `/v1` ({@link flowCookie}).
 * 2. The provider redirects to the public callback, which only forwards `code` and `state` in the
 *    URL fragment to the page ({@link oauthCallbackTarget}). The app itself never logs them; the
 *    hosting reverse proxy's access log may still record the callback URL with its query string.
 *    That is acceptable because the code is single-use, lives about 10 minutes, and is bound to the
 *    state in the HttpOnly cookie (and to the PKCE verifier or the client secret).
 * 3. `complete` opens the cookie ({@link openOAuthFlow}), expires it ({@link expiredFlowCookie}),
 *    and requires the flow to belong to the signed-in member and the state to match
 *    ({@link oauthFlowIsOwnersAndMatches}) before any code is exchanged.
 */

export const OAUTH_FLOW_COOKIE_PATH = '/v1';
export const OAUTH_FLOW_TTL_SECONDS = 600;

/** The fields every flow carries; providers add their own (verifier, returnTo, provider). */
export interface OAuthFlowBase {
  readonly organizationId: string;
  readonly organizationSlug: string;
  readonly membershipId: string;
  readonly state: string;
  /** Unix seconds. */
  readonly expiresAt: number;
}

/** 32 random bytes, base64url: a state or a PKCE verifier. */
export function randomFlowToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** The S256 challenge of a PKCE verifier. */
export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export function flowExpiry(nowSeconds: number = Math.floor(Date.now() / 1000)): number {
  return nowSeconds + OAUTH_FLOW_TTL_SECONDS;
}

function sign(purpose: string, payload: string, secret: string): string {
  return createHmac('sha256', secret).update(`${purpose}.${payload}`).digest('base64url');
}

/** `payload.signature`, the HMAC keyed by `purpose` so one provider's cookie never opens as another's. */
export function sealOAuthFlow(flow: object, purpose: string, secret: string): string {
  const payload = Buffer.from(JSON.stringify(flow), 'utf8').toString('base64url');
  return `${payload}.${sign(purpose, payload, secret)}`;
}

/**
 * The flow, or `undefined` for a missing, forged, malformed or expired cookie. Every name in
 * `strings` (plus the base fields) must be a string; `expiresAt` must be a number in the future.
 */
export function openOAuthFlow<T extends OAuthFlowBase>(
  raw: string | undefined,
  purpose: string,
  secret: string,
  options: { readonly strings?: readonly string[]; readonly nowSeconds?: number } = {},
): T | undefined {
  if (!raw) return undefined;
  const [payload, signature, extra] = raw.split('.');
  if (!payload || !signature || extra !== undefined) return undefined;
  if (!constantTimeEquals(signature, sign(purpose, payload, secret))) return undefined;
  try {
    const flow = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    > | null;
    if (flow === null || typeof flow !== 'object') return undefined;
    const names = [
      'state',
      'organizationId',
      'organizationSlug',
      'membershipId',
      ...(options.strings ?? []),
    ];
    if (names.some((name) => typeof flow[name] !== 'string')) return undefined;
    if (typeof flow['expiresAt'] !== 'number') return undefined;
    const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
    if (flow['expiresAt'] < now) return undefined;
    return flow as unknown as T;
  } catch {
    return undefined;
  }
}

export function oauthStateMatches(flow: OAuthFlowBase, returned: unknown): boolean {
  return typeof returned === 'string' && constantTimeEquals(flow.state, returned);
}

/**
 * The owner check before a code is exchanged: the flow exists, was started by this member in this
 * workspace, the returned state matches, and the code is a plausible string.
 */
export function oauthFlowIsOwnersAndMatches(
  flow: OAuthFlowBase | undefined,
  context: { readonly organizationId: string; readonly membershipId: string },
  input: { readonly code?: unknown; readonly state?: unknown },
): flow is OAuthFlowBase {
  const code = input.code;
  return (
    flow !== undefined &&
    flow.organizationId === context.organizationId &&
    flow.membershipId === context.membershipId &&
    oauthStateMatches(flow, input.state) &&
    typeof code === 'string' &&
    code !== '' &&
    code.length <= 4096
  );
}

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function isWorkspaceSlug(value: unknown): value is string {
  return typeof value === 'string' && SLUG_PATTERN.test(value);
}

/**
 * Where the provider's redirect sends the browser on: `{web}/{slug}/{page}#<provider>=complete&…`,
 * or `#<provider>=error` (refused consent, a bad request). The address is built only from
 * `WEB_PUBLIC_URL`, the slug in the signed cookie and a fixed page, so there is no open redirect.
 * Without a usable flow the browser goes to the web root.
 */
export function oauthCallbackTarget(input: {
  readonly provider: string;
  readonly webPublicUrl: string;
  readonly flow: OAuthFlowBase | undefined;
  readonly page: string;
  readonly query: { readonly code?: unknown; readonly state?: unknown; readonly error?: unknown };
}): string {
  const base = input.webPublicUrl.replace(/\/+$/, '');
  const { flow, provider, query } = input;
  if (!flow || !isWorkspaceSlug(flow.organizationSlug)) return `${base}/`;
  const screen = `${base}/${flow.organizationSlug}/${input.page}`;
  const { code, state } = query;
  if (
    query.error !== undefined ||
    typeof code !== 'string' ||
    typeof state !== 'string' ||
    code === '' ||
    code.length > 4096 ||
    state.length > 512
  ) {
    return `${screen}#${provider}=error`;
  }
  return `${screen}#${new URLSearchParams({ [provider]: 'complete', code, state }).toString()}`;
}

// ── Cookies ────────────────────────────────────────────────────────────────

export interface CookieRequest {
  readonly headers: Record<string, string | string[] | undefined>;
}

export interface CookieReply {
  header(name: string, value: string | readonly string[]): unknown;
}

export function cookieHeader(request: CookieRequest): string | undefined {
  const raw = request.headers['cookie'];
  return Array.isArray(raw) ? raw.join('; ') : raw;
}

export function readFlowCookie(request: CookieRequest, name: string): string | undefined {
  return readCookie(cookieHeader(request), name);
}

/** The `Set-Cookie` for a sealed flow. `Lax`: it must survive the top-level return. */
export function flowCookie(name: string, sealed: string, secure: boolean): string {
  return serializeCookie(name, sealed, {
    path: OAUTH_FLOW_COOKIE_PATH,
    maxAgeSeconds: OAUTH_FLOW_TTL_SECONDS,
    sameSite: 'Lax',
    secure,
  });
}

/** The `Set-Cookie` that ends a flow (single use, whatever happens next). */
export function expiredFlowCookie(name: string, secure: boolean): string {
  return expireCookie(name, { path: OAUTH_FLOW_COOKIE_PATH, sameSite: 'Lax', secure });
}

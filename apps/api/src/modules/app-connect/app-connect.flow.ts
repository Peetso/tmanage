import {
  flowExpiry,
  oauthCallbackTarget,
  openOAuthFlow,
  randomFlowToken,
  sealOAuthFlow,
  type OAuthFlowBase,
} from '../../common/http/oauth-flow.js';

/**
 * FIX5 one-click Connect for GitHub (owner/admin). The cookie, state, owner and callback checks are
 * the shared sign-in helper's (`common/http/oauth-flow.ts`, which Figma uses too); this file only
 * names the provider, its cookie and its PKCE verifier:
 *
 * 1. `POST …/app-connect/github/start` answers GitHub's consent address and sets the signed flow
 *    cookie on `/v1`: state, PKCE verifier, workspace, member.
 * 2. GitHub redirects to `GET /v1/integrations/github/callback`, which only forwards `code` and
 *    `state` in the URL fragment to the Integrations page. The app does not log them and the
 *    fragment keeps them out of a Referer, but the hosting proxy's access log may record the
 *    callback URL with its query string; the code is single-use, lives about 10 minutes and is
 *    bound to the PKCE verifier in the HttpOnly cookie.
 * 3. The page posts them to `…/app-connect/github/complete`, which checks the state against the
 *    cookie under the member's own session, exchanges the code and stores the token encrypted.
 *
 * Slack and Microsoft Teams were removed (FIX5, Peter 2026-11-10): their routes answer 404.
 */

export const APP_CONNECT_PROVIDERS = ['github'] as const;
export type AppConnectProvider = (typeof APP_CONNECT_PROVIDERS)[number];

export function isAppConnectProvider(value: unknown): value is AppConnectProvider {
  return typeof value === 'string' && (APP_CONNECT_PROVIDERS as readonly string[]).includes(value);
}

export function appConnectCookieName(provider: AppConnectProvider): string {
  return `tm_${provider}_flow`;
}

/** The callback the provider app is registered with (Peter's registration uses exactly this). */
export function appConnectCallbackPath(provider: AppConnectProvider): string {
  return `/v1/integrations/${provider}/callback`;
}

export interface AppConnectFlow extends OAuthFlowBase {
  readonly provider: AppConnectProvider;
  readonly verifier: string;
}

export function newAppConnectFlow(
  owner: {
    provider: AppConnectProvider;
    organizationId: string;
    organizationSlug: string;
    membershipId: string;
  },
  nowSeconds: number = Math.floor(Date.now() / 1000),
): AppConnectFlow {
  return {
    ...owner,
    state: randomFlowToken(),
    verifier: randomFlowToken(),
    expiresAt: flowExpiry(nowSeconds),
  };
}

const purpose = (provider: AppConnectProvider) => `app-connect.${provider}.v1`;

export function sealAppConnectFlow(flow: AppConnectFlow, secret: string): string {
  return sealOAuthFlow(flow, purpose(flow.provider), secret);
}

/**
 * The flow, or `undefined` for a missing, forged, malformed, expired or other-provider cookie.
 * The signature is keyed by `provider`.
 */
export function openAppConnectFlow(
  provider: AppConnectProvider,
  raw: string | undefined,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): AppConnectFlow | undefined {
  const flow = openOAuthFlow<AppConnectFlow>(raw, purpose(provider), secret, {
    strings: ['verifier'],
    nowSeconds,
  });
  return flow !== undefined && flow.provider === provider ? flow : undefined;
}

/**
 * Where the provider's redirect sends the browser on: the Integrations page with
 * `#<provider>=complete&code=…&state=…`, or `#<provider>=error` (refused consent, bad request).
 */
export function appConnectCallbackTarget(
  provider: AppConnectProvider,
  options: { readonly sessionSecret: string; readonly webPublicUrl: string },
  flowCookie: string | undefined,
  query: { readonly code?: unknown; readonly state?: unknown; readonly error?: unknown },
): string {
  return oauthCallbackTarget({
    provider,
    webPublicUrl: options.webPublicUrl,
    flow: openAppConnectFlow(provider, flowCookie, options.sessionSecret),
    page: 'automations/apps',
    query,
  });
}

/** Every provider call gives up after this long (they run inside a request). */
export const APP_CONNECT_TIMEOUT_MS = 10_000;

/** The provider refused the code or the token (bad, expired, revoked). */
export class AppConnectRefusedError extends Error {}
/** The provider could not be reached or answered something unusable. */
export class AppConnectUnavailableError extends Error {}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export const defaultFetch: FetchLike = (url, init) => globalThis.fetch(url, init);

/** One provider call with the timeout; a network failure becomes {@link AppConnectUnavailableError}. */
export async function providerCall(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  name: string,
): Promise<Response> {
  try {
    return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(APP_CONNECT_TIMEOUT_MS) });
  } catch {
    throw new AppConnectUnavailableError(`${name} could not be reached`);
  }
}

export async function jsonBody(response: Response): Promise<Record<string, unknown>> {
  const body = (await response.json().catch(() => null)) as unknown;
  return body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : {};
}

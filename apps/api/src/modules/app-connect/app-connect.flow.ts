import { createHash, createHmac, randomBytes } from 'node:crypto';
import { constantTimeEquals } from '../identity/session-token.js';

/**
 * FIX5 one-click connectors — the flow cookie and the provider's return, shared by GitHub, Slack
 * and Microsoft Teams. The shape is Figma's (`figma-oauth.ts`) with the PKCE verifier of the
 * Microsoft calendar flow (`microsoft-calendar.graph.ts`):
 *
 * 1. `POST …/app-connect/:provider/start` (owner/admin) answers the provider's consent address and
 *    sets a signed, short-lived flow cookie on `/v1`: state, PKCE verifier, workspace, member.
 * 2. The provider redirects to `GET /v1/integrations/<provider>/callback`, which only forwards
 *    `code` and `state` in the URL fragment to the Integrations page (never into a log or a
 *    Referer).
 * 3. The page posts them to `…/app-connect/:provider/complete`, which checks the state against the
 *    cookie under the member's own session, exchanges the code and stores the token encrypted.
 */

export const APP_CONNECT_PROVIDERS = ['github', 'slack', 'teams'] as const;
export type AppConnectProvider = (typeof APP_CONNECT_PROVIDERS)[number];

export function isAppConnectProvider(value: unknown): value is AppConnectProvider {
  return typeof value === 'string' && (APP_CONNECT_PROVIDERS as readonly string[]).includes(value);
}

export const APP_CONNECT_COOKIE_PATH = '/v1';
export const APP_CONNECT_FLOW_TTL_SECONDS = 600;

export function appConnectCookieName(provider: AppConnectProvider): string {
  return `tm_${provider}_flow`;
}

/** The callback each provider app is registered with (Peter's registration uses exactly these). */
export function appConnectCallbackPath(provider: AppConnectProvider): string {
  return `/v1/integrations/${provider}/callback`;
}

export interface AppConnectFlow {
  readonly provider: AppConnectProvider;
  readonly organizationId: string;
  readonly organizationSlug: string;
  readonly membershipId: string;
  readonly state: string;
  readonly verifier: string;
  /** Unix seconds. */
  readonly expiresAt: number;
}

const random = (bytes = 32) => randomBytes(bytes).toString('base64url');

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
    state: random(),
    verifier: random(),
    expiresAt: nowSeconds + APP_CONNECT_FLOW_TTL_SECONDS,
  };
}

/** The S256 challenge of a verifier. */
export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

function sign(provider: AppConnectProvider, payload: string, secret: string): string {
  return createHmac('sha256', secret)
    .update(`app-connect.${provider}.v1.${payload}`)
    .digest('base64url');
}

export function sealAppConnectFlow(flow: AppConnectFlow, secret: string): string {
  const payload = Buffer.from(JSON.stringify(flow), 'utf8').toString('base64url');
  return `${payload}.${sign(flow.provider, payload, secret)}`;
}

/**
 * The flow, or `undefined` for a missing, forged, malformed, expired or other-provider cookie.
 * The signature is keyed by `provider`, so GitHub's cookie never opens as Slack's.
 */
export function openAppConnectFlow(
  provider: AppConnectProvider,
  raw: string | undefined,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): AppConnectFlow | undefined {
  if (!raw) return undefined;
  const [payload, signature, extra] = raw.split('.');
  if (!payload || !signature || extra !== undefined) return undefined;
  if (!constantTimeEquals(signature, sign(provider, payload, secret))) return undefined;
  try {
    const flow = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as AppConnectFlow;
    const strings = [
      flow.state,
      flow.verifier,
      flow.organizationId,
      flow.organizationSlug,
      flow.membershipId,
    ];
    if (strings.some((s) => typeof s !== 'string') || typeof flow.expiresAt !== 'number') {
      return undefined;
    }
    if (flow.provider !== provider || flow.expiresAt < nowSeconds) return undefined;
    return flow;
  } catch {
    return undefined;
  }
}

export function appConnectStateMatches(flow: AppConnectFlow, returned: unknown): boolean {
  return typeof returned === 'string' && constantTimeEquals(flow.state, returned);
}

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function isWorkspaceSlug(value: unknown): value is string {
  return typeof value === 'string' && SLUG_PATTERN.test(value);
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
  const base = options.webPublicUrl.replace(/\/+$/, '');
  const flow = openAppConnectFlow(provider, flowCookie, options.sessionSecret);
  if (!flow || !isWorkspaceSlug(flow.organizationSlug)) return `${base}/`;
  const screen = `${base}/${flow.organizationSlug}/automations/apps`;
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

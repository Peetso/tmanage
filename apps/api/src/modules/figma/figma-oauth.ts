import { createHmac, randomBytes } from 'node:crypto';
import { constantTimeEquals } from '../identity/session-token.js';

/**
 * FIX4 item 6 — **Connect Figma in one click** (Peter's rule: "Connect, the provider authorizes,
 * done"). Figma's OAuth 2 app flow, used when the server has a Figma app registered
 * (`FIGMA_CLIENT_ID` + `FIGMA_CLIENT_SECRET`, free at figma.com/developers/apps). Without them the
 * personal-access-token path stays the fallback.
 *
 * 1. `POST …/figma/connection/start` answers Figma's consent address and sets a signed, short-lived
 *    flow cookie (state, organization, membership) on `/v1`.
 * 2. Figma redirects to `GET /v1/integrations/figma/callback`, which only forwards `code` and
 *    `state` in the URL fragment to the Integrations page (never to a server log or a Referer).
 * 3. The page posts them to `…/figma/connection/complete`, which checks the state against the
 *    cookie, exchanges the code under the member's own session, and stores the token encrypted.
 *
 * The stored secret is `oauth:<access token>` so the REST client sends it as a bearer token; a
 * pasted personal access token is stored bare and sent as `X-Figma-Token`.
 */

export const FIGMA_AUTHORIZE_URL = 'https://www.figma.com/oauth';
export const FIGMA_TOKEN_URL = 'https://api.figma.com/v1/oauth/token';
export const FIGMA_OAUTH_SCOPES = 'current_user:read file_content:read file_metadata:read';
export const FIGMA_CALLBACK_PATH = '/v1/integrations/figma/callback';
export const FIGMA_COOKIE_PATH = '/v1';
export const FIGMA_FLOW_COOKIE = 'tm_figma_flow';
export const FIGMA_FLOW_TTL_SECONDS = 600;
export const FIGMA_OAUTH_TIMEOUT_MS = 10_000;
/** The prefix that marks a stored OAuth access token (sent as `Authorization: Bearer`). */
export const FIGMA_OAUTH_TOKEN_PREFIX = 'oauth:';
const FLOW_PURPOSE = 'figma-flow.v1';

export interface FigmaOAuthConfig {
  readonly clientId: string;
  readonly clientSecret: string;
}

/** The Figma app from the environment, or `null` (one-click Connect is off). */
export function figmaOAuthConfigFrom(
  env: Readonly<Record<string, string | undefined>>,
): FigmaOAuthConfig | null {
  const clientId = env['FIGMA_CLIENT_ID']?.trim() ?? '';
  const clientSecret = env['FIGMA_CLIENT_SECRET']?.trim() ?? '';
  return clientId !== '' && clientSecret !== '' ? { clientId, clientSecret } : null;
}

/** The page that started Connect, and so the page Figma's return lands on. */
export type FigmaReturnTo = 'integrations' | 'connected-apps';

export function figmaReturnTo(value: unknown): FigmaReturnTo {
  return value === 'connected-apps' ? 'connected-apps' : 'integrations';
}

export interface FigmaFlow {
  readonly organizationId: string;
  readonly organizationSlug: string;
  readonly membershipId: string;
  readonly returnTo: FigmaReturnTo;
  readonly state: string;
  /** Unix seconds. */
  readonly expiresAt: number;
}

export function newFigmaFlow(
  owner: {
    organizationId: string;
    organizationSlug: string;
    membershipId: string;
    returnTo?: FigmaReturnTo;
  },
  nowSeconds: number = Math.floor(Date.now() / 1000),
): FigmaFlow {
  return {
    ...owner,
    returnTo: owner.returnTo ?? 'integrations',
    state: randomBytes(32).toString('base64url'),
    expiresAt: nowSeconds + FIGMA_FLOW_TTL_SECONDS,
  };
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(`${FLOW_PURPOSE}.${payload}`).digest('base64url');
}

export function sealFigmaFlow(flow: FigmaFlow, secret: string): string {
  const payload = Buffer.from(JSON.stringify(flow), 'utf8').toString('base64url');
  return `${payload}.${sign(payload, secret)}`;
}

/** The flow, or `undefined` for a missing, forged, malformed or expired cookie. */
export function openFigmaFlow(
  raw: string | undefined,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): FigmaFlow | undefined {
  if (!raw) return undefined;
  const [payload, signature, extra] = raw.split('.');
  if (!payload || !signature || extra !== undefined) return undefined;
  if (!constantTimeEquals(signature, sign(payload, secret))) return undefined;
  try {
    const flow = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as FigmaFlow;
    const strings = [flow.state, flow.organizationId, flow.organizationSlug, flow.membershipId];
    if (strings.some((s) => typeof s !== 'string') || typeof flow.expiresAt !== 'number') {
      return undefined;
    }
    if (flow.expiresAt < nowSeconds) return undefined;
    return { ...flow, returnTo: figmaReturnTo(flow.returnTo) };
  } catch {
    return undefined;
  }
}

export function figmaStateMatches(flow: FigmaFlow, returned: unknown): boolean {
  return typeof returned === 'string' && constantTimeEquals(flow.state, returned);
}

export function figmaAuthorizeUrl(input: {
  readonly config: FigmaOAuthConfig;
  readonly redirectUri: string;
  readonly state: string;
}): string {
  const params = new URLSearchParams({
    client_id: input.config.clientId,
    redirect_uri: input.redirectUri,
    scope: FIGMA_OAUTH_SCOPES,
    state: input.state,
    response_type: 'code',
  });
  return `${FIGMA_AUTHORIZE_URL}?${params.toString()}`;
}

export class FigmaOAuthRefusedError extends Error {}
export class FigmaOAuthUnavailableError extends Error {}

/** Swap the one-time code for an access token. The client authenticates with HTTP Basic. */
export async function exchangeFigmaCode(
  input: {
    readonly config: FigmaOAuthConfig;
    readonly redirectUri: string;
    readonly code: string;
  },
  fetchImpl: typeof fetch = (url, init) => globalThis.fetch(url, init),
): Promise<{ readonly accessToken: string }> {
  const basic = Buffer.from(`${input.config.clientId}:${input.config.clientSecret}`).toString(
    'base64',
  );
  let response: Response;
  try {
    response = await fetchImpl(FIGMA_TOKEN_URL, {
      method: 'POST',
      headers: {
        authorization: `Basic ${basic}`,
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: new URLSearchParams({
        redirect_uri: input.redirectUri,
        code: input.code,
        grant_type: 'authorization_code',
      }).toString(),
      signal: AbortSignal.timeout(FIGMA_OAUTH_TIMEOUT_MS),
    });
  } catch {
    throw new FigmaOAuthUnavailableError('Figma could not be reached');
  }
  if (response.status === 400 || response.status === 401 || response.status === 403) {
    throw new FigmaOAuthRefusedError(`Figma refused the code (${response.status})`);
  }
  if (!response.ok) throw new FigmaOAuthUnavailableError(`Figma answered ${response.status}`);
  const body = (await response.json().catch(() => null)) as { access_token?: unknown } | null;
  const accessToken = typeof body?.access_token === 'string' ? body.access_token : '';
  if (accessToken === '' || accessToken.length > 600) {
    throw new FigmaOAuthUnavailableError('Figma sent no usable token');
  }
  return { accessToken };
}

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** Where Figma's redirect sends the browser on: the Integrations page, code in the fragment. */
export function figmaCallbackTarget(
  options: { readonly sessionSecret: string; readonly webPublicUrl: string },
  flowCookie: string | undefined,
  code: unknown,
  state: unknown,
): string {
  const base = options.webPublicUrl.replace(/\/+$/, '');
  const flow = openFigmaFlow(flowCookie, options.sessionSecret);
  if (!flow || !SLUG_PATTERN.test(flow.organizationSlug)) return `${base}/`;
  const page = flow.returnTo === 'connected-apps' ? 'settings/connected-apps' : 'automations/apps';
  const screen = `${base}/${flow.organizationSlug}/${page}`;
  if (typeof code !== 'string' || typeof state !== 'string' || code.length > 4096) {
    return `${screen}#figma=error`;
  }
  return `${screen}#${new URLSearchParams({ figma: 'complete', code, state }).toString()}`;
}

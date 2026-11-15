import { createPublicKey, createVerify } from 'node:crypto';
import { constantTimeEquals } from '../identity/session-token.js';
import {
  IdTokenRejectedError,
  pkceChallenge,
  type GoogleClaims,
  type GoogleFlow,
  type GoogleJwk,
} from '../google-auth/google-oidc.js';

/**
 * "Continue with Microsoft" (51-05): Microsoft identity platform v2.0, OpenID Connect
 * authorization code + PKCE, the protocol half. It reuses Google's flow cookie, PKCE and claim
 * shapes (`google-oidc.ts`) and differs only where Microsoft does:
 *
 * - **Issuer.** With the `common` / `organizations` endpoints the token's issuer is the person's
 *   own tenant, `https://login.microsoftonline.com/{tid}/v2.0`. The `tid` claim must be a GUID,
 *   `iss` must equal that template filled with it, and when the signing key carries Microsoft's
 *   `issuer` template it must fill to the same value. A tenant pin (`organizations`,
 *   `consumers`, one tenant id) is enforced on `tid` too.
 * - **E-mail proof.** Microsoft's `email` claim is editable by a tenant admin, so it proves
 *   nothing on its own (the "nOAuth" takeover). It counts as verified only for a personal
 *   Microsoft account (the consumer tenant) or when the token says the domain owner verified it
 *   (`xms_edov`, an optional claim the app registration must request). Anything else is
 *   `email_unverified`: never linked, never signed in.
 * - **Subject.** `tid:oid` — stable for the person across app registrations, unlike `sub`.
 */

export const MICROSOFT_LOGIN_ORIGIN = 'https://login.microsoftonline.com';
/** The tenant every personal Microsoft account (outlook.com, hotmail.com, live.com) lives in. */
export const MICROSOFT_CONSUMER_TENANT = '9188040d-6c67-4c5b-b112-36a304b66dad';
export const MICROSOFT_SCOPES = 'openid email profile';
export const MICROSOFT_CALLBACK_PATH = '/v1/auth/microsoft/callback';
export const MICROSOFT_COOKIE_PATH = '/v1/auth/microsoft';
export const MICROSOFT_FLOW_COOKIE = 'tm_microsoft_flow';
export const MICROSOFT_MFA_COOKIE = 'tm_microsoft_mfa';
export const MICROSOFT_FLOW_PURPOSE = 'microsoft-oidc-flow.v1';
export const MICROSOFT_MFA_PURPOSE = 'microsoft-oidc-mfa.v1';
const CLOCK_SKEW_SECONDS = 60;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export interface MicrosoftSignInConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  /** `common` (default), `organizations`, `consumers`, or one tenant's GUID. */
  readonly tenant: string;
}

type Env = Readonly<Record<string, string | undefined>>;

/**
 * `MICROSOFT_SIGNIN_CLIENT_ID` / `MICROSOFT_SIGNIN_CLIENT_SECRET` / `MICROSOFT_SIGNIN_TENANT`, or
 * `null` (feature off: no routes, no button). Separate from OneDrive's `MICROSOFT_CLIENT_ID` so
 * connecting OneDrive never switches sign-in on with an unregistered return address.
 */
export function microsoftSignInConfigFrom(env: Env): MicrosoftSignInConfig | null {
  const clientId = env['MICROSOFT_SIGNIN_CLIENT_ID']?.trim();
  const clientSecret = env['MICROSOFT_SIGNIN_CLIENT_SECRET']?.trim();
  if (!clientId || !clientSecret) return null;
  const tenant = env['MICROSOFT_SIGNIN_TENANT']?.trim().toLowerCase() ?? '';
  const known = tenant === 'organizations' || tenant === 'consumers' || GUID.test(tenant);
  return { clientId, clientSecret, tenant: known ? tenant : 'common' };
}

export function authorizationUrl(input: {
  config: MicrosoftSignInConfig;
  redirectUri: string;
  flow: GoogleFlow;
}): string {
  const params = new URLSearchParams({
    response_type: 'code',
    response_mode: 'query',
    client_id: input.config.clientId,
    redirect_uri: input.redirectUri,
    scope: MICROSOFT_SCOPES,
    state: input.flow.state,
    nonce: input.flow.nonce,
    code_challenge: pkceChallenge(input.flow.verifier),
    code_challenge_method: 'S256',
    prompt: 'select_account',
  });
  return `${MICROSOFT_LOGIN_ORIGIN}/${input.config.tenant}/oauth2/v2.0/authorize?${params.toString()}`;
}

export interface MicrosoftJwk extends GoogleJwk {
  /** Microsoft's per-key issuer template, e.g. `https://login.microsoftonline.com/{tenantid}/v2.0`. */
  readonly issuer?: string;
}

function decodeSegment(segment: string): Record<string, unknown> {
  const parsed = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new IdTokenRejectedError('malformed');
  }
  return parsed as Record<string, unknown>;
}

function tenantAllowed(pin: string, tid: string): boolean {
  if (pin === 'common') return true;
  if (pin === 'consumers') return tid === MICROSOFT_CONSUMER_TENANT;
  if (pin === 'organizations') return tid !== MICROSOFT_CONSUMER_TENANT;
  return tid === pin;
}

function isTrue(value: unknown): boolean {
  return value === true || value === 1 || value === 'true' || value === '1';
}

/**
 * Verify a Microsoft v2.0 ID token and return the claims sign-in uses. Throws
 * {@link IdTokenRejectedError} with the precise reason; callers log it and show a generic line.
 */
export function verifyMicrosoftIdToken(input: {
  idToken: string;
  config: Pick<MicrosoftSignInConfig, 'clientId' | 'tenant'>;
  nonce: string;
  keys: readonly MicrosoftJwk[];
  nowSeconds?: number;
}): GoogleClaims {
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const parts = input.idToken.split('.');
  if (parts.length !== 3 || parts.some((part) => part === '')) {
    throw new IdTokenRejectedError('malformed');
  }
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    header = decodeSegment(headerPart);
    payload = decodeSegment(payloadPart);
  } catch (error) {
    if (error instanceof IdTokenRejectedError) throw error;
    throw new IdTokenRejectedError('malformed');
  }

  if (header['alg'] !== 'RS256') throw new IdTokenRejectedError('unsupported_algorithm');
  const key = input.keys.find(
    (candidate) => candidate.kid === header['kid'] && candidate.kty === 'RSA',
  );
  if (!key) throw new IdTokenRejectedError('unknown_key');
  const verifier = createVerify('RSA-SHA256');
  verifier.update(`${headerPart}.${payloadPart}`);
  const publicKey = createPublicKey({ key, format: 'jwk' });
  if (!verifier.verify(publicKey, Buffer.from(signaturePart, 'base64url'))) {
    throw new IdTokenRejectedError('bad_signature');
  }

  const tid = typeof payload['tid'] === 'string' ? payload['tid'].toLowerCase() : '';
  const expectedIssuer = `${MICROSOFT_LOGIN_ORIGIN}/${tid}/v2.0`;
  if (
    !GUID.test(tid) ||
    payload['iss'] !== expectedIssuer ||
    (key.issuer !== undefined && key.issuer.replace('{tenantid}', tid) !== expectedIssuer) ||
    !tenantAllowed(input.config.tenant, tid)
  ) {
    throw new IdTokenRejectedError('wrong_issuer');
  }
  const aud = payload['aud'];
  const audienceOk = Array.isArray(aud)
    ? aud.includes(input.config.clientId) && payload['azp'] === input.config.clientId
    : aud === input.config.clientId;
  if (!audienceOk) throw new IdTokenRejectedError('wrong_audience');

  const exp = payload['exp'];
  if (typeof exp !== 'number' || exp + CLOCK_SKEW_SECONDS < now) {
    throw new IdTokenRejectedError('expired');
  }
  const iat = payload['iat'];
  const nbf = payload['nbf'];
  if (
    typeof iat !== 'number' ||
    iat - CLOCK_SKEW_SECONDS > now ||
    (typeof nbf === 'number' && nbf - CLOCK_SKEW_SECONDS > now)
  ) {
    throw new IdTokenRejectedError('issued_in_future');
  }
  const nonce = payload['nonce'];
  if (typeof nonce !== 'string' || !constantTimeEquals(nonce, input.nonce)) {
    throw new IdTokenRejectedError('bad_nonce');
  }
  const email = payload['email'];
  const verified = tid === MICROSOFT_CONSUMER_TENANT || isTrue(payload['xms_edov']);
  if (!verified || typeof email !== 'string' || email.trim() === '') {
    throw new IdTokenRejectedError('email_unverified');
  }
  const oid = payload['oid'];
  if (typeof oid !== 'string' || oid === '') throw new IdTokenRejectedError('no_subject');

  const name = typeof payload['name'] === 'string' ? payload['name'].trim() : '';
  return { subject: `${tid}:${oid.toLowerCase()}`, email: email.trim().toLowerCase(), name };
}

// ── Transport ────────────────────────────────────────────────────────────────

/** The two network calls, behind an interface so the suites never reach Microsoft. */
export interface MicrosoftTransport {
  exchangeCode(input: {
    code: string;
    config: MicrosoftSignInConfig;
    redirectUri: string;
    verifier: string;
  }): Promise<{ readonly idToken: string }>;
  signingKeys(config: Pick<MicrosoftSignInConfig, 'tenant'>): Promise<readonly MicrosoftJwk[]>;
}

const KEY_CACHE_MS = 60 * 60 * 1000;

export function createMicrosoftTransport(fetchImpl: typeof fetch = fetch): MicrosoftTransport {
  let cached: { keys: readonly MicrosoftJwk[]; at: number } | undefined;
  return {
    async exchangeCode(input) {
      const response = await fetchImpl(
        `${MICROSOFT_LOGIN_ORIGIN}/${input.config.tenant}/oauth2/v2.0/token`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code: input.code,
            client_id: input.config.clientId,
            client_secret: input.config.clientSecret,
            redirect_uri: input.redirectUri,
            code_verifier: input.verifier,
            scope: MICROSOFT_SCOPES,
          }).toString(),
        },
      );
      if (!response.ok) throw new Error(`Microsoft token endpoint answered ${response.status}`);
      const body = (await response.json()) as { id_token?: unknown };
      if (typeof body.id_token !== 'string') {
        throw new Error('Microsoft token response had no id_token');
      }
      return { idToken: body.id_token };
    },
    async signingKeys(config) {
      if (cached && Date.now() - cached.at < KEY_CACHE_MS) return cached.keys;
      const response = await fetchImpl(
        `${MICROSOFT_LOGIN_ORIGIN}/${config.tenant}/discovery/v2.0/keys`,
      );
      if (!response.ok) throw new Error(`Microsoft JWKS answered ${response.status}`);
      const body = (await response.json()) as { keys?: unknown };
      const keys = Array.isArray(body.keys) ? (body.keys as MicrosoftJwk[]) : [];
      cached = { keys, at: Date.now() };
      return keys;
    },
  };
}

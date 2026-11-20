import { createHash, createHmac, createPublicKey, createVerify, randomBytes } from 'node:crypto';
import type { JsonWebKey } from 'node:crypto';
import type { SignupAttribution } from '@tmanage/domain';
import { constantTimeEquals } from '../identity/session-token.js';

/**
 * "Continue with Google": OpenID Connect authorization code + PKCE, the protocol half.
 *
 * Nothing here touches the database. The pieces are:
 *
 * - **The flow cookie.** `state`, `nonce` and the PKCE verifier are generated per attempt and
 *   kept in an HttpOnly cookie signed with `SESSION_SECRET` under its own purpose string, so they
 *   are bound to the browser that started the attempt. The callback refuses unless the `state`
 *   Google returns equals the cookie's (constant time) and the ID token's `nonce` equals the
 *   cookie's — a callback replayed into another browser has no cookie to match.
 * - **ID token verification.** RS256 signature against Google's published keys, then `iss`
 *   (accounts.google.com), `aud` (our client id; `azp` too when `aud` is a list), `exp`/`iat`
 *   with a minute of skew, `nonce`, and `email_verified === true`. Every refusal is a named
 *   reason that is logged, never shown.
 * - **Scopes** are `openid email profile` and nothing else — separate from any Drive access.
 */

export const GOOGLE_AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
export const GOOGLE_JWKS_URI = 'https://www.googleapis.com/oauth2/v3/certs';
export const GOOGLE_ISSUERS: readonly string[] = [
  'https://accounts.google.com',
  'accounts.google.com',
];
export const GOOGLE_SCOPES = 'openid email profile';
export const GOOGLE_CALLBACK_PATH = '/v1/auth/google/callback';
/** The flow cookie is sent only to the Google routes. */
export const GOOGLE_COOKIE_PATH = '/v1/auth/google';
export const GOOGLE_FLOW_COOKIE = 'tm_google_flow';
export const GOOGLE_MFA_COOKIE = 'tm_google_mfa';
/** Ten minutes to choose an account on Google's screen. */
export const GOOGLE_FLOW_TTL_SECONDS = 600;
const CLOCK_SKEW_SECONDS = 60;
const FLOW_PURPOSE = 'google-oidc-flow.v1';
const MFA_PURPOSE = 'google-oidc-mfa.v1';

export type GoogleIntent = 'sign-in' | 'sign-up' | 'invitation';

export interface GoogleFlow {
  readonly intent: GoogleIntent;
  readonly state: string;
  readonly nonce: string;
  readonly verifier: string;
  /** Unix seconds. */
  readonly expiresAt: number;
  /** Invitation flow only. Kept in the HttpOnly cookie, never in a URL Google sees. */
  readonly invitationToken?: string;
  /** Sign-up flow only: the workspace name typed before choosing Google, if any. */
  readonly organizationName?: string;
  /**
   * Sign-up flow only (ADTRACK, NOCOOKIE): the `utm_*` values the sign-up form sent with the
   * start request, like `organizationName` part of the sign-up the person asked for. They ride
   * in this sealed, ten-minute flow only across Google's redirect, never in a URL Google sees.
   */
  readonly signupAttribution?: SignupAttribution;
  /**
   * Sign-up flow only (LANE-Q): the personal trial link's token, carried across Google's redirect
   * in this sealed cookie, never in a URL Google sees. Checked again when the account is made.
   */
  readonly trialToken?: string;
}

export interface GoogleClaims {
  readonly subject: string;
  readonly email: string;
  readonly name: string;
}

export type IdTokenRejection =
  | 'malformed'
  | 'unsupported_algorithm'
  | 'unknown_key'
  | 'bad_signature'
  | 'wrong_issuer'
  | 'wrong_audience'
  | 'expired'
  | 'issued_in_future'
  | 'bad_nonce'
  | 'email_unverified'
  | 'no_subject';

export class IdTokenRejectedError extends Error {
  override name = 'IdTokenRejectedError';
  constructor(readonly reason: IdTokenRejection) {
    super(`Google ID token rejected: ${reason}`);
  }
}

function base64url(buffer: Buffer): string {
  return buffer.toString('base64url');
}

function random(bytes = 32): string {
  return base64url(randomBytes(bytes));
}

export function newFlow(
  intent: GoogleIntent,
  extra: {
    invitationToken?: string;
    organizationName?: string;
    signupAttribution?: SignupAttribution;
    trialToken?: string;
  } = {},
  nowSeconds: number = Math.floor(Date.now() / 1000),
): GoogleFlow {
  return {
    intent,
    state: random(),
    nonce: random(),
    // RFC 7636: 43–128 characters of unreserved text; 32 random bytes is 43.
    verifier: random(),
    expiresAt: nowSeconds + GOOGLE_FLOW_TTL_SECONDS,
    ...(extra.invitationToken === undefined ? {} : { invitationToken: extra.invitationToken }),
    ...(extra.organizationName === undefined ? {} : { organizationName: extra.organizationName }),
    ...(extra.signupAttribution === undefined
      ? {}
      : { signupAttribution: extra.signupAttribution }),
    ...(extra.trialToken === undefined ? {} : { trialToken: extra.trialToken }),
  };
}

export function pkceChallenge(verifier: string): string {
  return base64url(createHash('sha256').update(verifier).digest());
}

export function authorizationUrl(input: {
  clientId: string;
  redirectUri: string;
  flow: GoogleFlow;
  loginHint?: string;
}): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    scope: GOOGLE_SCOPES,
    state: input.flow.state,
    nonce: input.flow.nonce,
    code_challenge: pkceChallenge(input.flow.verifier),
    code_challenge_method: 'S256',
    prompt: 'select_account',
  });
  if (input.loginHint) params.set('login_hint', input.loginHint);
  return `${GOOGLE_AUTHORIZATION_ENDPOINT}?${params.toString()}`;
}

// ── Signed cookie values ─────────────────────────────────────────────────────

function sign(payload: string, secret: string, purpose: string): string {
  return createHmac('sha256', secret).update(`${purpose}.${payload}`).digest('base64url');
}

function seal(value: unknown, secret: string, purpose: string): string {
  const payload = base64url(Buffer.from(JSON.stringify(value), 'utf8'));
  return `${payload}.${sign(payload, secret, purpose)}`;
}

function unseal(raw: string | undefined, secret: string, purpose: string): unknown {
  if (!raw) return undefined;
  const [payload, signature, ...rest] = raw.split('.');
  if (!payload || !signature || rest.length > 0) return undefined;
  if (!constantTimeEquals(signature, sign(payload, secret, purpose))) return undefined;
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
}

/** `purpose` separates providers: a Google flow cookie never opens as a Microsoft one. */
export function sealFlow(flow: GoogleFlow, secret: string, purpose: string = FLOW_PURPOSE): string {
  return seal(flow, secret, purpose);
}

/** The flow, or undefined when the cookie is missing, forged, malformed or expired. */
export function openFlow(
  raw: string | undefined,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
  purpose: string = FLOW_PURPOSE,
): GoogleFlow | undefined {
  const value = unseal(raw, secret, purpose) as Partial<GoogleFlow> | undefined;
  if (
    !value ||
    (value.intent !== 'sign-in' && value.intent !== 'sign-up' && value.intent !== 'invitation') ||
    typeof value.state !== 'string' ||
    typeof value.nonce !== 'string' ||
    typeof value.verifier !== 'string' ||
    typeof value.expiresAt !== 'number' ||
    value.expiresAt < nowSeconds
  ) {
    return undefined;
  }
  return value as GoogleFlow;
}

/** The state Google echoed must be the one this browser's cookie holds. */
export function stateMatches(flow: GoogleFlow, returned: unknown): boolean {
  return (
    typeof returned === 'string' && returned !== '' && constantTimeEquals(flow.state, returned)
  );
}

export interface PendingMfa {
  readonly challengeToken: string;
  readonly expiresAt: string;
  readonly factors: readonly {
    readonly id: string;
    readonly kind: string;
    readonly label: string;
  }[];
  /** Where to go after the second factor, e.g. back to the invitation. */
  readonly returnTo: string;
}

export function sealPendingMfa(
  value: PendingMfa,
  secret: string,
  purpose: string = MFA_PURPOSE,
): string {
  return seal(value, secret, purpose);
}

export function openPendingMfa(
  raw: string | undefined,
  secret: string,
  purpose: string = MFA_PURPOSE,
): PendingMfa | undefined {
  const value = unseal(raw, secret, purpose) as Partial<PendingMfa> | undefined;
  if (
    !value ||
    typeof value.challengeToken !== 'string' ||
    typeof value.expiresAt !== 'string' ||
    !Array.isArray(value.factors) ||
    typeof value.returnTo !== 'string'
  ) {
    return undefined;
  }
  return value as PendingMfa;
}

// ── ID token ─────────────────────────────────────────────────────────────────

export interface GoogleJwk extends JsonWebKey {
  readonly kid?: string;
  readonly alg?: string;
}

function decodeSegment(segment: string): Record<string, unknown> {
  const parsed = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new IdTokenRejectedError('malformed');
  }
  return parsed as Record<string, unknown>;
}

/**
 * Verify a Google ID token and return the three claims this application uses. Throws
 * {@link IdTokenRejectedError} with the precise reason; callers log it and show a generic line.
 */
export function verifyIdToken(input: {
  idToken: string;
  clientId: string;
  nonce: string;
  keys: readonly GoogleJwk[];
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

  if (typeof payload['iss'] !== 'string' || !GOOGLE_ISSUERS.includes(payload['iss'])) {
    throw new IdTokenRejectedError('wrong_issuer');
  }
  const aud = payload['aud'];
  const audienceOk = Array.isArray(aud)
    ? aud.includes(input.clientId) && payload['azp'] === input.clientId
    : aud === input.clientId;
  if (!audienceOk) throw new IdTokenRejectedError('wrong_audience');

  const exp = payload['exp'];
  if (typeof exp !== 'number' || exp + CLOCK_SKEW_SECONDS < now) {
    throw new IdTokenRejectedError('expired');
  }
  const iat = payload['iat'];
  if (typeof iat !== 'number' || iat - CLOCK_SKEW_SECONDS > now) {
    throw new IdTokenRejectedError('issued_in_future');
  }
  const nonce = payload['nonce'];
  if (typeof nonce !== 'string' || !constantTimeEquals(nonce, input.nonce)) {
    throw new IdTokenRejectedError('bad_nonce');
  }
  const verified = payload['email_verified'];
  const email = payload['email'];
  if ((verified !== true && verified !== 'true') || typeof email !== 'string' || email === '') {
    throw new IdTokenRejectedError('email_unverified');
  }
  const subject = payload['sub'];
  if (typeof subject !== 'string' || subject === '') throw new IdTokenRejectedError('no_subject');

  const name = typeof payload['name'] === 'string' ? payload['name'].trim() : '';
  return { subject, email: email.trim().toLowerCase(), name };
}

// ── Transport ────────────────────────────────────────────────────────────────

/** The two network calls, behind an interface so the suites never reach Google. */
export interface GoogleTransport {
  exchangeCode(input: {
    code: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    verifier: string;
  }): Promise<{ readonly idToken: string }>;
  signingKeys(): Promise<readonly GoogleJwk[]>;
}

const KEY_CACHE_MS = 60 * 60 * 1000;

export function createGoogleTransport(fetchImpl: typeof fetch = fetch): GoogleTransport {
  let cached: { keys: readonly GoogleJwk[]; at: number } | undefined;
  return {
    async exchangeCode(input) {
      const response = await fetchImpl(GOOGLE_TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: input.code,
          client_id: input.clientId,
          client_secret: input.clientSecret,
          redirect_uri: input.redirectUri,
          code_verifier: input.verifier,
        }).toString(),
      });
      if (!response.ok) throw new Error(`Google token endpoint answered ${response.status}`);
      const body = (await response.json()) as { id_token?: unknown };
      if (typeof body.id_token !== 'string')
        throw new Error('Google token response had no id_token');
      return { idToken: body.id_token };
    },
    async signingKeys() {
      if (cached && Date.now() - cached.at < KEY_CACHE_MS) return cached.keys;
      const response = await fetchImpl(GOOGLE_JWKS_URI);
      if (!response.ok) throw new Error(`Google JWKS answered ${response.status}`);
      const body = (await response.json()) as { keys?: unknown };
      const keys = Array.isArray(body.keys) ? (body.keys as GoogleJwk[]) : [];
      cached = { keys, at: Date.now() };
      return keys;
    },
  };
}

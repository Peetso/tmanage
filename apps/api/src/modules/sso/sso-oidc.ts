import { createHmac, createPublicKey, createVerify, randomBytes } from 'node:crypto';
import type { JsonWebKey } from 'node:crypto';
import { pkceChallenge } from '../google-auth/google-oidc.js';
import { constantTimeEquals } from '../identity/session-token.js';

/**
 * 54-14 — company sign-in over OpenID Connect, the protocol half. Nothing here touches the
 * database or the network.
 *
 * - **The flow cookie** holds the organization, `state`, `nonce` and the PKCE verifier, signed
 *   with `SESSION_SECRET` under its own purpose string, so a callback replayed into another
 *   browser has nothing to match.
 * - **ID token verification**: RS256 against the issuer's JWKS, then `iss` (exactly the configured
 *   issuer), `aud` (the client id; `azp` too when `aud` is a list), `exp`/`iat` with a minute of
 *   skew, `nonce`, and an e-mail the provider did not mark unverified. Each refusal is a named
 *   reason that is logged, never shown.
 */

export const SSO_CALLBACK_PATH = '/v1/auth/sso/callback';
export const SSO_COOKIE_PATH = '/v1/auth/sso';
export const SSO_FLOW_COOKIE = 'tm_sso_flow';
export const SSO_MFA_COOKIE = 'tm_sso_mfa';
export const SSO_FLOW_TTL_SECONDS = 600;
export const SSO_SCOPES = 'openid email profile';
const CLOCK_SKEW_SECONDS = 60;
const FLOW_PURPOSE = 'sso-oidc-flow.v1';

/** Consumer mailbox domains no organization may claim for its company sign-in. */
export const PUBLIC_MAIL_DOMAINS: ReadonlySet<string> = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'yahoo.com',
  'icloud.com',
  'me.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'gmx.com',
  'yandex.com',
  'mail.com',
]);

const DOMAIN_PATTERN = /^(?=.{3,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u;

export interface SsoFlow {
  readonly organizationId: string;
  readonly state: string;
  readonly nonce: string;
  readonly verifier: string;
  /** Unix seconds. */
  readonly expiresAt: number;
}

export interface SsoClaims {
  readonly subject: string;
  readonly email: string;
  readonly name: string;
}

export type SsoTokenRejection =
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
  | 'no_subject'
  /** 56-10o: the flow's state was already used once (a replayed callback). */
  | 'replayed';

export class SsoTokenRejectedError extends Error {
  override name = 'SsoTokenRejectedError';
  constructor(readonly reason: SsoTokenRejection) {
    super(`SSO ID token rejected: ${reason}`);
  }
}

export interface SsoJwk extends JsonWebKey {
  readonly kid?: string;
  readonly alg?: string;
}

const random = (bytes = 32): string => randomBytes(bytes).toString('base64url');

export function newSsoFlow(
  organizationId: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): SsoFlow {
  return {
    organizationId,
    state: random(),
    nonce: random(),
    verifier: random(),
    expiresAt: nowSeconds + SSO_FLOW_TTL_SECONDS,
  };
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(`${FLOW_PURPOSE}.${payload}`).digest('base64url');
}

export function sealSsoFlow(flow: SsoFlow, secret: string): string {
  const payload = Buffer.from(JSON.stringify(flow), 'utf8').toString('base64url');
  return `${payload}.${sign(payload, secret)}`;
}

/** The flow, or undefined when the cookie is missing, forged, malformed or expired. */
export function openSsoFlow(
  raw: string | undefined,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): SsoFlow | undefined {
  if (!raw) return undefined;
  const [payload, signature, ...rest] = raw.split('.');
  if (!payload || !signature || rest.length > 0) return undefined;
  if (!constantTimeEquals(signature, sign(payload, secret))) return undefined;
  let value: Partial<SsoFlow>;
  try {
    value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Partial<SsoFlow>;
  } catch {
    return undefined;
  }
  if (
    typeof value.organizationId !== 'string' ||
    typeof value.state !== 'string' ||
    typeof value.nonce !== 'string' ||
    typeof value.verifier !== 'string' ||
    typeof value.expiresAt !== 'number' ||
    value.expiresAt < nowSeconds
  ) {
    return undefined;
  }
  return value as SsoFlow;
}

/** The state the provider echoed must be the one this browser's cookie holds. */
export function ssoStateMatches(flow: SsoFlow, returned: unknown): boolean {
  return (
    typeof returned === 'string' && returned !== '' && constantTimeEquals(flow.state, returned)
  );
}

export function ssoAuthorizationUrl(input: {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  flow: SsoFlow;
  loginHint?: string;
}): string {
  const url = new URL(input.authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('scope', SSO_SCOPES);
  url.searchParams.set('state', input.flow.state);
  url.searchParams.set('nonce', input.flow.nonce);
  url.searchParams.set('code_challenge', pkceChallenge(input.flow.verifier));
  url.searchParams.set('code_challenge_method', 'S256');
  if (input.loginHint) url.searchParams.set('login_hint', input.loginHint);
  return url.toString();
}

// ── Settings helpers ─────────────────────────────────────────────────────────

/** `https://host[/path]` without a trailing slash, query or fragment; null when unusable. */
export function normalizeIssuer(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 500) return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    return null;
  }
  return `${url.origin}${url.pathname.replace(/\/+$/u, '')}`;
}

export function isClaimableDomain(domain: string): boolean {
  return DOMAIN_PATTERN.test(domain) && !PUBLIC_MAIL_DOMAINS.has(domain);
}

export function parseDomainList(stored: string): string[] {
  return stored
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part !== '');
}

/** The lower-case domain of an e-mail address, or null when it is not one. */
export function emailDomain(email: unknown): string | null {
  if (typeof email !== 'string') return null;
  const trimmed = email.trim().toLowerCase();
  const at = trimmed.lastIndexOf('@');
  if (at < 1 || at !== trimmed.indexOf('@')) return null;
  const domain = trimmed.slice(at + 1);
  return DOMAIN_PATTERN.test(domain) ? domain : null;
}

// ── ID token ─────────────────────────────────────────────────────────────────

function decodeSegment(segment: string): Record<string, unknown> {
  const parsed = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new SsoTokenRejectedError('malformed');
  }
  return parsed as Record<string, unknown>;
}

/** The `kid` of a token's header, for a key refresh on an unknown key; undefined if unreadable. */
export function tokenKeyId(idToken: string): string | undefined {
  try {
    const kid = decodeSegment(idToken.split('.')[0] ?? '')['kid'];
    return typeof kid === 'string' ? kid : undefined;
  } catch {
    return undefined;
  }
}

/** Verify an ID token from the organization's provider and return the claims sign-in uses. */
export function verifySsoIdToken(input: {
  idToken: string;
  issuer: string;
  clientId: string;
  nonce: string;
  keys: readonly SsoJwk[];
  nowSeconds?: number;
}): SsoClaims {
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const parts = input.idToken.split('.');
  if (parts.length !== 3 || parts.some((part) => part === '')) {
    throw new SsoTokenRejectedError('malformed');
  }
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    header = decodeSegment(headerPart);
    payload = decodeSegment(payloadPart);
  } catch (error) {
    if (error instanceof SsoTokenRejectedError) throw error;
    throw new SsoTokenRejectedError('malformed');
  }

  if (header['alg'] !== 'RS256') throw new SsoTokenRejectedError('unsupported_algorithm');
  // 56-10o kid confusion: only RSA signing keys count (an `enc` key or one pinned to another
  // algorithm never verifies), a kid must name exactly one of them, and a kid-less token is
  // accepted only when the issuer publishes a single signing key.
  const signingKeys = input.keys.filter(
    (candidate) =>
      candidate.kty === 'RSA' &&
      (candidate['use'] === undefined || candidate['use'] === 'sig') &&
      (candidate.alg === undefined || candidate.alg === 'RS256'),
  );
  const kid = header['kid'];
  if (kid !== undefined && typeof kid !== 'string') throw new SsoTokenRejectedError('unknown_key');
  const named = kid === undefined ? signingKeys : signingKeys.filter((c) => c.kid === kid);
  const key = named.length === 1 ? named[0] : undefined;
  if (!key) throw new SsoTokenRejectedError('unknown_key');
  let valid = false;
  try {
    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${headerPart}.${payloadPart}`);
    valid = verifier.verify(
      createPublicKey({ key, format: 'jwk' }),
      Buffer.from(signaturePart, 'base64url'),
    );
  } catch {
    valid = false;
  }
  if (!valid) throw new SsoTokenRejectedError('bad_signature');

  if (payload['iss'] !== input.issuer) throw new SsoTokenRejectedError('wrong_issuer');
  const aud = payload['aud'];
  const azp = payload['azp'];
  const audienceOk = Array.isArray(aud)
    ? aud.includes(input.clientId) && (aud.length === 1 || azp === input.clientId)
    : aud === input.clientId;
  // 56-10o: an `azp` naming another client is a token issued to that client (OIDC Core §2).
  if (!audienceOk || (azp !== undefined && azp !== input.clientId)) {
    throw new SsoTokenRejectedError('wrong_audience');
  }

  const exp = payload['exp'];
  if (typeof exp !== 'number' || exp + CLOCK_SKEW_SECONDS < now) {
    throw new SsoTokenRejectedError('expired');
  }
  const iat = payload['iat'];
  if (typeof iat !== 'number' || iat - CLOCK_SKEW_SECONDS > now) {
    throw new SsoTokenRejectedError('issued_in_future');
  }
  const nbf = payload['nbf'];
  if (nbf !== undefined && (typeof nbf !== 'number' || nbf - CLOCK_SKEW_SECONDS > now)) {
    throw new SsoTokenRejectedError('issued_in_future');
  }
  const nonce = payload['nonce'];
  if (typeof nonce !== 'string' || !constantTimeEquals(nonce, input.nonce)) {
    throw new SsoTokenRejectedError('bad_nonce');
  }
  const email = payload['email'];
  const verified = payload['email_verified'];
  if (
    typeof email !== 'string' ||
    emailDomain(email) === null ||
    verified === false ||
    verified === 'false'
  ) {
    throw new SsoTokenRejectedError('email_unverified');
  }
  const subject = payload['sub'];
  if (typeof subject !== 'string' || subject === '') throw new SsoTokenRejectedError('no_subject');
  const name = typeof payload['name'] === 'string' ? payload['name'].trim() : '';
  return { subject, email: email.trim().toLowerCase(), name };
}

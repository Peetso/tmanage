import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { isBlockedAddress } from '../oauth/ssrf.js';
import type { SsoJwk } from './sso-oidc.js';

/**
 * 54-14 — the network half of company sign-in: the issuer's discovery document, its signing keys
 * (JWKS, cached) and the code exchange. Behind an interface so the suites never reach a provider.
 *
 * The issuer is typed by an organization owner, so every URL fetched here is `https:` and its host
 * must not resolve to a private, loopback or link-local address (the OAuth module's SSRF list).
 * Redirects are not followed and every call has a five-second deadline.
 */

export interface SsoProviderMetadata {
  readonly issuer: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly jwksUri: string;
}

export interface SsoTransport {
  discover(issuer: string): Promise<SsoProviderMetadata>;
  /** The issuer's keys; `refresh` skips the cache (an unknown `kid` after a key rollover). */
  signingKeys(jwksUri: string, refresh?: boolean): Promise<readonly SsoJwk[]>;
  exchangeCode(input: {
    tokenEndpoint: string;
    code: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    verifier: string;
  }): Promise<{ readonly idToken: string }>;
}

export class SsoProviderError extends Error {
  override name = 'SsoProviderError';
}

const DEADLINE_MS = 5_000;
const DISCOVERY_CACHE_MS = 10 * 60 * 1000;
const KEY_CACHE_MS = 60 * 60 * 1000;
const MAX_CACHE_ENTRIES = 200;

type Resolver = (host: string) => Promise<readonly string[]>;

const defaultResolver: Resolver = async (host) =>
  (await lookup(host, { all: true })).map((entry) => entry.address);

/** Refuses anything but a public `https:` URL. */
export async function assertPublicHttps(raw: string, resolve: Resolver): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SsoProviderError('not a URL');
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new SsoProviderError('only https URLs are fetched');
  }
  const host = url.hostname.replace(/^\[|\]$/gu, '');
  const addresses = isIP(host) ? [host] : await resolve(host);
  if (addresses.length === 0 || addresses.some((address) => isBlockedAddress(address))) {
    throw new SsoProviderError('the host is not a public address');
  }
  return url;
}

function remember<T>(cache: Map<string, { value: T; at: number }>, key: string, value: T): T {
  if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value as string);
  cache.set(key, { value, at: Date.now() });
  return value;
}

function stringField(body: Record<string, unknown>, name: string): string {
  const value = body[name];
  if (typeof value !== 'string' || value === '') throw new SsoProviderError(`no ${name}`);
  return value;
}

export function createSsoTransport(
  fetchImpl: typeof fetch = fetch,
  resolve: Resolver = defaultResolver,
): SsoTransport {
  const discovery = new Map<string, { value: SsoProviderMetadata; at: number }>();
  const keys = new Map<string, { value: readonly SsoJwk[]; at: number }>();

  async function getJson(raw: string, init?: RequestInit): Promise<Record<string, unknown>> {
    const url = await assertPublicHttps(raw, resolve);
    const response = await fetchImpl(url, {
      ...init,
      redirect: 'manual',
      signal: AbortSignal.timeout(DEADLINE_MS),
    });
    if (!response.ok) throw new SsoProviderError(`provider answered ${response.status}`);
    const body = (await response.json()) as unknown;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new SsoProviderError('provider answered something that is not a JSON object');
    }
    return body as Record<string, unknown>;
  }

  return {
    async discover(issuer) {
      const hit = discovery.get(issuer);
      if (hit && Date.now() - hit.at < DISCOVERY_CACHE_MS) return hit.value;
      const body = await getJson(`${issuer}/.well-known/openid-configuration`);
      // OIDC Discovery §4.3: the document's issuer must be exactly the one asked for.
      if (body['issuer'] !== issuer) throw new SsoProviderError('discovery issuer mismatch');
      return remember(discovery, issuer, {
        issuer,
        authorizationEndpoint: stringField(body, 'authorization_endpoint'),
        tokenEndpoint: stringField(body, 'token_endpoint'),
        jwksUri: stringField(body, 'jwks_uri'),
      });
    },
    async signingKeys(jwksUri, refresh = false) {
      const hit = keys.get(jwksUri);
      if (!refresh && hit && Date.now() - hit.at < KEY_CACHE_MS) return hit.value;
      const body = await getJson(jwksUri);
      const list = Array.isArray(body['keys']) ? (body['keys'] as SsoJwk[]) : [];
      return remember(keys, jwksUri, list);
    },
    async exchangeCode(input) {
      const body = await getJson(input.tokenEndpoint, {
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
      if (typeof body['id_token'] !== 'string') throw new SsoProviderError('no id_token');
      return { idToken: body['id_token'] };
    },
  };
}

import type { ApiClient } from './client';
import { ApiRequestError } from './errors';

/**
 * 54-14 — company sign-in over OpenID Connect, the browser half.
 *
 * - The owner's settings: `GET`/`PUT`/`DELETE …/security/sso`. The client secret is sent once and
 *   never read back (`hasClientSecret` says one is stored).
 * - 54-15: the connection speaks OpenID Connect or SAML 2.0 (`protocol`). For SAML the owner
 *   pastes the IdP metadata XML or its entity ID, sign-in URL and signing certificate; the view
 *   gives back the SP entity ID and the ACS URL for the IdP. The certificate is never read back,
 *   only its fingerprint and expiry.
 * - Sign-in: `POST /v1/auth/sso/start {email}` answers the provider's URL, or 404 when no company
 *   sign-in is set up for that address. State, nonce and the PKCE verifier stay in an HttpOnly
 *   cookie the API sets; nothing here sees them.
 */

/** Mirrors the API's `SsoConnectionView`. */
export interface SsoConnectionView {
  readonly configured: boolean;
  readonly issuer: string;
  readonly clientId: string;
  readonly hasClientSecret: boolean;
  readonly allowedDomains: readonly string[];
  readonly enforce: boolean;
  readonly autoJoin: boolean;
  readonly redirectUri: string;
  readonly secretStorageReady: boolean;
  readonly updatedAt: string | null;
  readonly protocol: SsoProtocol;
  readonly samlEntityId: string;
  readonly samlSsoUrl: string;
  readonly samlCertificate: { readonly fingerprint: string; readonly expiresAt: string } | null;
  readonly spEntityId: string;
  readonly acsUrl: string;
}

export type SsoProtocol = 'oidc' | 'saml';

/** The SAML half of the settings; empty metadata and certificate keep what is stored. */
export interface SsoSamlInput {
  readonly idpMetadataXml: string;
  readonly idpEntityId: string;
  readonly idpSsoUrl: string;
  readonly idpCertificate: string;
}

export interface SsoSettingsInput {
  readonly protocol: SsoProtocol;
  readonly saml: SsoSamlInput;
  readonly issuer: string;
  readonly clientId: string;
  /** Empty = keep the stored secret. */
  readonly clientSecret: string;
  readonly allowedDomains: readonly string[];
  readonly enforce: boolean;
  readonly autoJoin: boolean;
}

/** POST /v1/auth/sso/start — where to send the browser. */
export interface SsoStartView {
  readonly url: string;
}

/** POST /v1/auth/sso/mfa — the second-factor challenge a company sign-in parked. */
export interface SsoPendingMfaView {
  readonly status: 'mfa_required';
  readonly challengeToken: string;
  readonly expiresAt: string;
  readonly factors: readonly {
    readonly id: string;
    readonly kind: string;
    readonly label: string;
  }[];
  readonly returnTo: string;
}

function path(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/security/sso`;
}

export async function readSsoConnection(
  client: ApiClient,
  organizationSlug: string,
): Promise<SsoConnectionView> {
  const { data } = await client.request<SsoConnectionView>({ path: path(organizationSlug) });
  return data;
}

export async function saveSsoConnection(
  client: ApiClient,
  organizationSlug: string,
  input: SsoSettingsInput,
): Promise<SsoConnectionView> {
  const { data } = await client.request<SsoConnectionView>({
    method: 'PUT',
    path: path(organizationSlug),
    body: ssoSettingsBody(input),
  });
  return data;
}

/** The PUT body: only the chosen protocol's fields, and no empty secret or certificate. */
export function ssoSettingsBody(input: SsoSettingsInput): Record<string, unknown> {
  const common = {
    protocol: input.protocol,
    allowedDomains: [...input.allowedDomains],
    enforce: input.enforce,
    autoJoin: input.autoJoin,
  };
  if (input.protocol === 'saml') {
    const { idpMetadataXml, idpEntityId, idpSsoUrl, idpCertificate } = input.saml;
    if (idpMetadataXml.trim() !== '') return { ...common, idpMetadataXml };
    return {
      ...common,
      idpEntityId: idpEntityId.trim(),
      idpSsoUrl: idpSsoUrl.trim(),
      ...(idpCertificate.trim() === '' ? {} : { idpCertificate }),
    };
  }
  return {
    ...common,
    issuer: input.issuer,
    clientId: input.clientId,
    ...(input.clientSecret.trim() === '' ? {} : { clientSecret: input.clientSecret }),
  };
}

export async function removeSsoConnection(
  client: ApiClient,
  organizationSlug: string,
): Promise<SsoConnectionView> {
  const { data } = await client.request<SsoConnectionView>({
    method: 'DELETE',
    path: path(organizationSlug),
  });
  return data;
}

/** "a.com, b.com" → ['a.com', 'b.com'], lower-cased, empties dropped. */
export function splitDomains(text: string): string[] {
  return text
    .split(/[\s,;]+/u)
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part !== '');
}

/** The provider URL, or null when no company sign-in is set up for this address. */
export async function startSso(client: ApiClient, email: string): Promise<string | null> {
  try {
    const { data } = await client.request<SsoStartView>({
      method: 'POST',
      path: '/v1/auth/sso/start',
      body: { email },
      authentication: 'none',
    });
    return data.url;
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 404) return null;
    throw error;
  }
}

/** The parked challenge, once; null when there is none (expired, already taken). */
export async function takeSsoPendingMfa(client: ApiClient): Promise<SsoPendingMfaView | null> {
  try {
    const { data } = await client.request<SsoPendingMfaView>({
      method: 'POST',
      path: '/v1/auth/sso/mfa',
      authentication: 'none',
    });
    return data;
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 404) return null;
    throw error;
  }
}

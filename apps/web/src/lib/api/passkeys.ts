import type { ApiClient } from './client';

/**
 * 56-22 — passkeys, the security-page device list and the security score, the browser half.
 * Mirrors `apps/api/src/modules/identity/passkeys/passkeys.controller.ts`.
 *
 * The WebAuthn options travel as JSON with every binary field in base64url; the helpers below turn
 * them into the `ArrayBuffer`s `navigator.credentials` wants and the answer back into base64url.
 */

export const REAUTH_HEADER = 'x-reauth-token';

export interface PasskeyView {
  readonly id: string;
  readonly name: string;
  readonly backedUp: boolean;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
}

export interface SecurityDeviceView {
  readonly id: string;
  readonly current: boolean;
  readonly browser: string | null;
  readonly os: string | null;
  readonly deviceType: string;
  readonly country: string | null;
  readonly countryCode: string | null;
  readonly lastSeenAt: string;
}

export type SecurityCheckId = 'two_step' | 'passkey' | 'recovery_codes' | 'recent_password';

export interface SecurityScoreView {
  readonly score: number;
  readonly checks: readonly {
    readonly id: SecurityCheckId;
    readonly passed: boolean;
    readonly points: number;
    readonly fix: 'two-step' | 'sign-in-security' | 'password';
  }[];
}

interface CreationOptionsJson {
  readonly challenge: string;
  readonly rp: { readonly id: string; readonly name: string };
  readonly user: { readonly id: string; readonly name: string; readonly displayName: string };
  readonly pubKeyCredParams: readonly { readonly type: 'public-key'; readonly alg: number }[];
  readonly timeout: number;
  readonly attestation: AttestationConveyancePreference;
  readonly authenticatorSelection: AuthenticatorSelectionCriteria;
}

interface RequestOptionsJson {
  readonly challenge: string;
  readonly rpId: string;
  readonly timeout: number;
  readonly userVerification: UserVerificationRequirement;
}

export function fromBase64Url(value: string): ArrayBuffer {
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/');
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export function toBase64Url(buffer: ArrayBuffer): string {
  let binary = '';
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

/** Whether this browser can create and use passkeys at all. */
export function passkeysSupported(): boolean {
  return typeof window !== 'undefined' && typeof window.PublicKeyCredential === 'function';
}

export async function listPasskeys(client: ApiClient): Promise<readonly PasskeyView[]> {
  const { data } = await client.request<{ passkeys: readonly PasskeyView[] }>({
    path: '/v1/auth/passkeys',
  });
  return data.passkeys;
}

export async function getSecurityScore(client: ApiClient): Promise<SecurityScoreView> {
  return (await client.request<SecurityScoreView>({ path: '/v1/auth/security-score' })).data;
}

export async function listSecurityDevices(
  client: ApiClient,
): Promise<readonly SecurityDeviceView[]> {
  const { data } = await client.request<{ devices: readonly SecurityDeviceView[] }>({
    path: '/v1/auth/security-devices',
  });
  return data.devices;
}

const withReauth = (token: string | null): Readonly<Record<string, string>> =>
  token ? { [REAUTH_HEADER]: token } : {};

/** Create a passkey on this device and register it. Throws the API's 403 when proof is needed. */
export async function addPasskey(
  client: ApiClient,
  input: { name: string; reauthToken: string | null },
): Promise<{ id: string }> {
  const { data: options } = await client.request<{
    challengeToken: string;
    publicKey: CreationOptionsJson;
  }>({ method: 'POST', path: '/v1/auth/passkeys/options' });
  const json = options.publicKey;
  const created = (await navigator.credentials.create({
    publicKey: {
      ...json,
      pubKeyCredParams: [...json.pubKeyCredParams],
      challenge: fromBase64Url(json.challenge),
      user: { ...json.user, id: fromBase64Url(json.user.id) },
    },
  })) as PublicKeyCredential | null;
  if (created === null) throw new Error('passkey_cancelled');
  const response = created.response as AuthenticatorAttestationResponse;
  const { data } = await client.request<{ id: string }>({
    method: 'POST',
    path: '/v1/auth/passkeys',
    headers: withReauth(input.reauthToken),
    body: {
      challengeToken: options.challengeToken,
      name: input.name,
      credential: {
        id: created.id,
        response: {
          clientDataJSON: toBase64Url(response.clientDataJSON),
          attestationObject: toBase64Url(response.attestationObject),
        },
        transports: typeof response.getTransports === 'function' ? response.getTransports() : [],
      },
    },
  });
  return data;
}

export async function removePasskey(
  client: ApiClient,
  input: { id: string; reauthToken: string | null },
): Promise<void> {
  await client.request<void>({
    method: 'DELETE',
    path: `/v1/auth/passkeys/${encodeURIComponent(input.id)}`,
    headers: withReauth(input.reauthToken),
  });
}

/** Sign out one device (`DELETE /v1/sessions/:id`) or every other one (`DELETE /v1/sessions`). */
export async function signOutDevice(
  client: ApiClient,
  input: { id: string | 'others'; reauthToken: string | null },
): Promise<void> {
  await client.request<void>({
    method: 'DELETE',
    path: input.id === 'others' ? '/v1/sessions' : `/v1/sessions/${encodeURIComponent(input.id)}`,
    headers: withReauth(input.reauthToken),
  });
}

export async function reauthenticate(
  client: ApiClient,
  input: { password: string; code?: string },
): Promise<string> {
  const { data } = await client.request<{ reauthToken: string }>({
    method: 'POST',
    path: '/v1/auth/reauth',
    body: input.code
      ? { password: input.password, code: input.code }
      : { password: input.password },
  });
  return data.reauthToken;
}

/** Sign in with a passkey on this device. Sets the session cookies; returns the CSRF token. */
export async function signInWithPasskey(client: ApiClient): Promise<void> {
  const { data: options } = await client.request<{
    challengeToken: string;
    publicKey: RequestOptionsJson;
  }>({ method: 'POST', path: '/v1/auth/passkey/options', authentication: 'none' });
  const assertion = (await navigator.credentials.get({
    publicKey: { ...options.publicKey, challenge: fromBase64Url(options.publicKey.challenge) },
  })) as PublicKeyCredential | null;
  if (assertion === null) throw new Error('passkey_cancelled');
  const response = assertion.response as AuthenticatorAssertionResponse;
  const { data } = await client.request<{ csrfToken: string }>({
    method: 'POST',
    path: '/v1/auth/passkey',
    authentication: 'none',
    body: {
      challengeToken: options.challengeToken,
      credential: {
        id: assertion.id,
        response: {
          clientDataJSON: toBase64Url(response.clientDataJSON),
          authenticatorData: toBase64Url(response.authenticatorData),
          signature: toBase64Url(response.signature),
          userHandle: response.userHandle ? toBase64Url(response.userHandle) : null,
        },
      },
    },
  });
  client.rememberCsrfToken(data.csrfToken);
}

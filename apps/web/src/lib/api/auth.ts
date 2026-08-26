import type { ApiClient } from './client';

/**
 * The ID-002 authentication endpoints, as the screens use them.
 *
 * Hand-written for the boundary reason `errors.ts` gives — `apps/web` may not import
 * `@tmanage/api` — and replaced when `packages/contracts` is generated from `openapi.yaml`.
 */

export interface AuthenticatedResponse {
  readonly status: 'authenticated';
  readonly csrfToken: string;
  readonly expiresAt: string;
}

export interface MfaRequiredResponse {
  readonly status: 'mfa_required';
  /**
   * Carries the half-finished sign-in to the second step.
   *
   * It is held in React state and never written to a URL, `localStorage`, or anywhere else
   * that persists. A query parameter would put it in the address bar, in browser history, and
   * in the `Referer` header of the next outbound request; the workspace lint rule already
   * forbids the storage options. Losing it on a reload is the correct behaviour — the person
   * signs in again, which costs them one password and costs an attacker the whole token.
   */
  readonly challengeToken: string;
  readonly expiresAt: string;
  readonly factors: readonly {
    readonly id: string;
    readonly kind: string;
    readonly label: string;
  }[];
}

export type SignInResponse = AuthenticatedResponse | MfaRequiredResponse;

export async function signInWithPassword(
  client: ApiClient,
  input: { email: string; password: string },
): Promise<SignInResponse> {
  const { data } = await client.request<SignInResponse>({
    method: 'POST',
    path: '/v1/auth/password',
    body: input,
  });
  return data;
}

export async function completeMfaChallenge(
  client: ApiClient,
  input: { challengeToken: string; code: string },
): Promise<AuthenticatedResponse> {
  const { data } = await client.request<AuthenticatedResponse>({
    method: 'POST',
    path: '/v1/auth/mfa',
    body: input,
  });
  return data;
}

export async function completeWithRecoveryCode(
  client: ApiClient,
  input: { challengeToken: string; code: string },
): Promise<AuthenticatedResponse> {
  const { data } = await client.request<AuthenticatedResponse>({
    method: 'POST',
    path: '/v1/auth/recovery-code',
    body: input,
  });
  return data;
}

export interface EnrolledFactor {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  /** `null` while enrolment is unfinished. An unconfirmed factor authorises nothing. */
  readonly confirmedAt: string | null;
}

export async function listFactors(
  client: ApiClient,
): Promise<{ factors: readonly EnrolledFactor[]; recoveryCodesRemaining: number }> {
  const { data } = await client.request<{
    factors: readonly EnrolledFactor[];
    recoveryCodesRemaining: number;
  }>({ path: '/v1/auth/factors' });
  return data;
}

export async function setPassword(client: ApiClient, password: string): Promise<void> {
  await client.request<void>({ method: 'POST', path: '/v1/auth/password/set', body: { password } });
}

export async function beginTotpEnrolment(
  client: ApiClient,
  input: { label: string; accountName?: string },
): Promise<{ factorId: string; secret: string; uri: string }> {
  const { data } = await client.request<{ factorId: string; secret: string; uri: string }>({
    method: 'POST',
    path: '/v1/auth/factors/totp',
    body: input,
  });
  return data;
}

/** Returns the recovery codes, once. There is nowhere to fetch them from a second time. */
export async function confirmTotpEnrolment(
  client: ApiClient,
  input: { factorId: string; code: string },
): Promise<{ recoveryCodes: readonly string[] }> {
  const { data } = await client.request<{ recoveryCodes: readonly string[] }>({
    method: 'POST',
    path: '/v1/auth/factors/totp/confirm',
    body: input,
  });
  return data;
}

export async function regenerateRecoveryCodes(
  client: ApiClient,
): Promise<{ recoveryCodes: readonly string[] }> {
  const { data } = await client.request<{ recoveryCodes: readonly string[] }>({
    method: 'POST',
    path: '/v1/auth/recovery-codes',
  });
  return data;
}

export async function disableFactor(client: ApiClient, factorId: string): Promise<void> {
  await client.request<void>({ method: 'DELETE', path: `/v1/auth/factors/${factorId}` });
}

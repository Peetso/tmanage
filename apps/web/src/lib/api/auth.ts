import type { ApiClient } from './client';
import { REAUTH_HEADER, reauthenticate } from './passkeys';

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

/**
 * R12 (R1). What the sign-in page reports about itself, so the API can tell a person from a
 * script: ms from render to submit, keys pressed, `navigator.webdriver`, the UA-data brands.
 * Advisory only — the API ignores any odd value rather than refusing the sign-in.
 */
export interface SignInClientSignals {
  readonly webdriver?: boolean;
  readonly formMs?: number;
  readonly keystrokes?: number;
  readonly hints?: string;
}

export async function signInWithPassword(
  client: ApiClient,
  input: { email: string; password: string; client?: SignInClientSignals },
): Promise<SignInResponse> {
  const { data } = await client.request<SignInResponse>({
    method: 'POST',
    path: '/v1/auth/password',
    body: input,
    // A wrong password is a 401 that means "wrong password", not "expired" — see `client.ts`.
    authentication: 'none',
  });
  if (data.status === 'authenticated') client.rememberCsrfToken(data.csrfToken);
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
    authentication: 'none',
  });
  client.rememberCsrfToken(data.csrfToken);
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
    authentication: 'none',
  });
  client.rememberCsrfToken(data.csrfToken);
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

/**
 * Set or change this person's password. Changing an existing one needs the `x-reauth-token` proof
 * from `POST /v1/auth/reauth`; a first password needs none (the API asks for a fresh sign-in).
 */
export async function setPassword(
  client: ApiClient,
  password: string,
  reauthToken?: string,
): Promise<void> {
  await client.request<void>({
    method: 'POST',
    path: '/v1/auth/password/set',
    ...(reauthToken === undefined ? {} : { headers: { [REAUTH_HEADER]: reauthToken } }),
    body: { password },
  });
}

/**
 * ACCOUNT item 4 (live persona test 2026-11-15): change the signed-in person's own password from
 * their profile. The current password is proved first (`POST /v1/auth/reauth`, rate limited, with
 * the authenticator code when two-step is on) and that short-lived proof goes with the change; the
 * API applies the sign-up password rules, keeps this session and ends every other one. An empty
 * current password is the first-password case (an account made with Google), which needs no proof.
 */
export async function changeMyPassword(
  client: ApiClient,
  input: { readonly currentPassword: string; readonly newPassword: string; readonly code?: string },
): Promise<void> {
  const reauthToken =
    input.currentPassword === ''
      ? undefined
      : await reauthenticate(client, {
          password: input.currentPassword,
          ...(input.code === undefined || input.code === '' ? {} : { code: input.code }),
        });
  await setPassword(client, input.newPassword, reauthToken);
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

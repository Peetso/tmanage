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

/**
 * Finish the second step with a six-digit code. `method: 'email'` says the code came by e-mail;
 * without it the code is an authenticator code. The API accepts only a method the person holds.
 */
export async function completeMfaChallenge(
  client: ApiClient,
  input: { challengeToken: string; code: string; method?: 'email' },
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

/** MFAOPTIONS. Where a two-step code was mailed (masked), and the resend and expiry times. */
export interface EmailCodeSentView {
  readonly sentTo: string;
  readonly resendAfterSeconds: number;
  readonly expiresInSeconds: number;
}

/** MFAOPTIONS. "Get a code by e-mail" during sign-in. 429 inside the 30-second pause. */
export async function sendSignInEmailCode(
  client: ApiClient,
  input: { challengeToken: string },
): Promise<EmailCodeSentView> {
  const { data } = await client.request<EmailCodeSentView>({
    method: 'POST',
    path: '/v1/auth/mfa/email-code',
    body: input,
    authentication: 'none',
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
  /** MFAOPTIONS: the method a sign-in asks for first. */
  readonly isDefault: boolean;
}

/** MFAOPTIONS. The account address an e-mail code goes to (masked) and whether it is verified. */
export interface FactorMailContact {
  readonly address: string;
  readonly verified: boolean;
}

export interface FactorsView {
  readonly factors: readonly EnrolledFactor[];
  readonly recoveryCodesRemaining: number;
  readonly email: FactorMailContact;
}

export async function listFactors(client: ApiClient): Promise<FactorsView> {
  const { data } = await client.request<FactorsView>({ path: '/v1/auth/factors' });
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

/** MFAOPTIONS. `POST /v1/auth/factors/email`: the pending method and where its code went. */
export interface EmailFactorStartedView extends EmailCodeSentView {
  readonly factorId: string;
}

/** MFAOPTIONS. Begin turning e-mail codes on; mails a code. Needs the re-auth proof. */
export async function beginEmailFactor(
  client: ApiClient,
  reauthToken?: string,
): Promise<EmailFactorStartedView> {
  const { data } = await client.request<EmailFactorStartedView>({
    method: 'POST',
    path: '/v1/auth/factors/email',
    ...reauthHeaders(reauthToken),
  });
  return data;
}

/** MFAOPTIONS. Finish turning e-mail codes on. New backup codes only when none were left. */
export async function confirmEmailFactor(
  client: ApiClient,
  input: { factorId: string; code: string },
  reauthToken?: string,
): Promise<{ recoveryCodes: readonly string[] }> {
  const { data } = await client.request<{ recoveryCodes: readonly string[] }>({
    method: 'POST',
    path: '/v1/auth/factors/email/confirm',
    ...reauthHeaders(reauthToken),
    body: input,
  });
  return data;
}

/** MFAOPTIONS. Make one method the one a sign-in asks for first. Needs the re-auth proof. */
export async function setDefaultFactor(
  client: ApiClient,
  factorId: string,
  reauthToken?: string,
): Promise<void> {
  await client.request<void>({
    method: 'POST',
    path: `/v1/auth/factors/${encodeURIComponent(factorId)}/default`,
    ...reauthHeaders(reauthToken),
  });
}

/** The `x-reauth-token` header when a step-up proof is held; nothing otherwise (the API asks). */
function reauthHeaders(reauthToken: string | undefined): { headers?: Record<string, string> } {
  return reauthToken === undefined ? {} : { headers: { [REAUTH_HEADER]: reauthToken } };
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

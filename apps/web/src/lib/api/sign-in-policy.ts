import type { ApiClient } from './client';
import { ApiRequestError } from './errors';

/**
 * A16 — the organization sign-in policy (`GET`/`PUT …/security/sign-in-policy`): which sign-in
 * methods members may use and who must use two-step sign-in. The change is the owner's alone and
 * needs fresh proof (`x-reauth-token` from `POST /v1/auth/reauth`).
 */

export type SignInMethodKey = 'password' | 'google' | 'microsoft' | 'sso';
export type TwoStepRoleScopeKey = 'nobody' | 'admins' | 'everyone';

export const SIGN_IN_METHOD_KEYS: readonly SignInMethodKey[] = [
  'password',
  'google',
  'microsoft',
  'sso',
];
export const TWO_STEP_SCOPE_KEYS: readonly TwoStepRoleScopeKey[] = ['nobody', 'admins', 'everyone'];

export interface SignInPolicyState {
  readonly allowedMethods: readonly SignInMethodKey[];
  readonly requireTwoStepRoles: TwoStepRoleScopeKey;
  readonly graceUntil: string | null;
  readonly sessionMaxHours: number;
  readonly idleSignOutMinutes: number;
  readonly membersWithoutAlternative: number;
  readonly ownMethods: readonly SignInMethodKey[];
}

function path(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/security/sign-in-policy`;
}

export async function readSignInPolicy(
  client: ApiClient,
  organizationSlug: string,
): Promise<SignInPolicyState> {
  const { data } = await client.request<SignInPolicyState>({ path: path(organizationSlug) });
  return data;
}

export async function updateSignInPolicy(
  client: ApiClient,
  organizationSlug: string,
  input: {
    readonly allowedMethods: readonly SignInMethodKey[];
    readonly requireTwoStepRoles: TwoStepRoleScopeKey;
  },
  reauthToken?: string,
): Promise<SignInPolicyState> {
  const { data } = await client.request<SignInPolicyState>({
    method: 'PUT',
    path: path(organizationSlug),
    body: {
      allowedMethods: [...input.allowedMethods],
      requireTwoStepRoles: input.requireTwoStepRoles,
    },
    headers: reauthToken ? { 'x-reauth-token': reauthToken } : {},
  });
  return data;
}

/** Which 409 refusal this is: the owner's own way in, or members left without a method. */
export function signInPolicyRefusal(error: unknown): 'owner' | 'members' | null {
  if (!(error instanceof ApiRequestError) || error.status !== 409) return null;
  const fields = error.fieldErrors();
  if (fields.has('ownMethods')) return 'owner';
  if (fields.has('count')) return 'members';
  return null;
}

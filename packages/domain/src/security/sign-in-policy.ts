import { isClientRole } from '../policies/capabilities.js';

/**
 * 56-25 — the organization sign-in policy, as pure rules.
 *
 * Three keys in the organization's access-policy document (`org_policies.policy_json`):
 *
 * - `signin.allowed_methods` — how members may sign in (at least one method).
 * - `security.require_two_step_roles` — who must hold a second factor: nobody, admins, everyone.
 * - `security.two_step_grace_until` — when the grace period of the last tightening ends (ISO).
 *
 * Session length is not a key here: it is the existing `session_max_hours` / idle sign-out pair,
 * which the policy read only exposes. Owners are exempt from every refusal (break-glass, 56-10).
 */

/**
 * The sign-in methods a policy may name. `microsoft` (51-05) and `sso` (54-14) are accepted values
 * that no sign-in path can use yet, so a policy cannot lock anyone out through them.
 */
export const SIGN_IN_METHODS = ['password', 'google', 'microsoft', 'sso'] as const;
export type SignInMethod = (typeof SIGN_IN_METHODS)[number];

export const TWO_STEP_ROLE_SCOPES = ['nobody', 'admins', 'everyone'] as const;
export type TwoStepRoleScope = (typeof TWO_STEP_ROLE_SCOPES)[number];

/** The roles `admins` covers. */
export const TWO_STEP_ADMIN_ROLES: readonly string[] = Object.freeze([
  'owner',
  'org_admin',
  'workspace_admin',
]);

/** How long people affected by a tightening have to enrol before they are refused. */
export const TWO_STEP_GRACE_DAYS = 14;

export const SIGN_IN_POLICY_KEYS = {
  allowedMethods: 'signin.allowed_methods',
  requireTwoStepRoles: 'security.require_two_step_roles',
  graceUntil: 'security.two_step_grace_until',
} as const;

export interface SignInPolicy {
  readonly allowedMethods: readonly SignInMethod[];
  readonly requireTwoStepRoles: TwoStepRoleScope;
  readonly graceUntil: string | null;
}

export const DEFAULT_SIGN_IN_POLICY: SignInPolicy = Object.freeze({
  allowedMethods: Object.freeze([...SIGN_IN_METHODS]) as readonly SignInMethod[],
  requireTwoStepRoles: 'nobody',
  graceUntil: null,
});

export function isSignInMethod(value: unknown): value is SignInMethod {
  return typeof value === 'string' && (SIGN_IN_METHODS as readonly string[]).includes(value);
}

export function isTwoStepRoleScope(value: unknown): value is TwoStepRoleScope {
  return typeof value === 'string' && (TWO_STEP_ROLE_SCOPES as readonly string[]).includes(value);
}

/** Canonical order, no duplicates; `null` when the value is not a list of known methods. */
function canonicalMethods(value: unknown): SignInMethod[] | null {
  if (!Array.isArray(value) || !value.every(isSignInMethod)) return null;
  return SIGN_IN_METHODS.filter((method) => value.includes(method));
}

/**
 * Read the sign-in keys from a stored policy document (parsed JSON or its text). Anything absent or
 * malformed reads as the default: every method, nobody required, no grace.
 */
export function parseSignInPolicy(raw: unknown): SignInPolicy {
  let doc: unknown = raw;
  if (typeof raw === 'string') {
    try {
      doc = JSON.parse(raw);
    } catch {
      return DEFAULT_SIGN_IN_POLICY;
    }
  }
  if (typeof doc !== 'object' || doc === null) return DEFAULT_SIGN_IN_POLICY;
  const record = doc as Record<string, unknown>;
  const methods = canonicalMethods(record[SIGN_IN_POLICY_KEYS.allowedMethods]);
  const scope = record[SIGN_IN_POLICY_KEYS.requireTwoStepRoles];
  const grace = record[SIGN_IN_POLICY_KEYS.graceUntil];
  return {
    allowedMethods:
      methods !== null && methods.length > 0 ? methods : DEFAULT_SIGN_IN_POLICY.allowedMethods,
    requireTwoStepRoles: isTwoStepRoleScope(scope) ? scope : 'nobody',
    graceUntil: typeof grace === 'string' && !Number.isNaN(Date.parse(grace)) ? grace : null,
  };
}

export type SignInPolicyPatchResult =
  | {
      readonly ok: true;
      readonly allowedMethods: readonly SignInMethod[];
      readonly requireTwoStepRoles: TwoStepRoleScope;
    }
  | { readonly ok: false; readonly field: string; readonly message: string };

/** Validate a PUT body `{allowedMethods, requireTwoStepRoles}`. An empty method list is refused. */
export function validateSignInPolicyPatch(body: unknown): SignInPolicyPatchResult {
  const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  const methods = canonicalMethods(record['allowedMethods']);
  if (methods === null) {
    return {
      ok: false,
      field: 'allowedMethods',
      message: `must be a list of ${SIGN_IN_METHODS.join(', ')}`,
    };
  }
  if (methods.length === 0) {
    return { ok: false, field: 'allowedMethods', message: 'keep at least one sign-in method' };
  }
  const scope = record['requireTwoStepRoles'];
  if (!isTwoStepRoleScope(scope)) {
    return {
      ok: false,
      field: 'requireTwoStepRoles',
      message: `must be one of ${TWO_STEP_ROLE_SCOPES.join(', ')}`,
    };
  }
  return { ok: true, allowedMethods: methods, requireTwoStepRoles: scope };
}

/** Whether `after` requires two-step of more people than `before`. */
export function isTwoStepTightened(before: TwoStepRoleScope, after: TwoStepRoleScope): boolean {
  return TWO_STEP_ROLE_SCOPES.indexOf(after) > TWO_STEP_ROLE_SCOPES.indexOf(before);
}

/** The grace deadline a tightening made at `now` grants. */
export function twoStepGraceUntil(now: Date): string {
  return new Date(now.getTime() + TWO_STEP_GRACE_DAYS * 86_400_000).toISOString();
}

export type SignInVerdict =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: 'method_not_allowed';
      readonly use: readonly SignInMethod[];
    };

/** May this person sign in to this organization with `method`? Owners always may. */
export function evaluateSignIn(input: {
  readonly policy: SignInPolicy;
  readonly method: SignInMethod;
  readonly isOwner: boolean;
}): SignInVerdict {
  if (input.isOwner || input.policy.allowedMethods.includes(input.method)) return { ok: true };
  return { ok: false, reason: 'method_not_allowed', use: input.policy.allowedMethods };
}

/** Whether the policy's role scope covers this role (`everyone` = every internal role). */
export function twoStepScopeCovers(scope: TwoStepRoleScope, roleKey: string): boolean {
  if (scope === 'nobody') return false;
  if (scope === 'admins') return TWO_STEP_ADMIN_ROLES.includes(roleKey);
  return !isClientRole(roleKey);
}

/**
 * Must this person hold a second factor? `false` when not covered or already enrolled; `'grace'`
 * inside the grace period (allowed, warned); `'required'` after it. Owners are never refused in the
 * beta: they get `'grace'` (the warning) for as long as they lack a factor.
 */
export function twoStepRequiredFor(input: {
  readonly policy: SignInPolicy;
  readonly roleKey: string;
  readonly isOwner: boolean;
  readonly hasSecondFactor: boolean;
  readonly now: Date;
}): false | 'required' | 'grace' {
  if (input.hasSecondFactor) return false;
  if (!twoStepScopeCovers(input.policy.requireTwoStepRoles, input.roleKey)) return false;
  if (input.isOwner) return 'grace';
  const until = input.policy.graceUntil === null ? NaN : Date.parse(input.policy.graceUntil);
  return !Number.isNaN(until) && input.now.getTime() < until ? 'grace' : 'required';
}

/**
 * The census: every `authentication_events.action` that begins or completes a sign-in, and the
 * method it is. `null` = a second step (code or recovery code) completing a sign-in whose method
 * the first step already decided and was checked on.
 */
export const SIGN_IN_METHOD_OF_ACTION: Readonly<Record<string, SignInMethod | null>> =
  Object.freeze({
    password_sign_in: 'password',
    google_sign_in: 'google',
    mfa_challenge: null,
    recovery_code: null,
  });

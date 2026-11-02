import {
  capabilitiesFor,
  capabilitySetFor,
  CAPABILITIES,
  clientCeilingViolations,
  hasCapability,
  INTERNAL_ROLES,
  isCustomRoleId,
  isPlatformSupportRole,
  isRole,
  mayGrantCapability,
  parseCustomRoleCapabilities,
} from '@tmanage/domain';
import type { Capability, Principal, PrincipalRole, Role } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';
import { MemberBulkRoleRepository } from './member-bulk-role.repository.js';

/**
 * Wave 9 S3 — the one rule for "may this caller hand out this role?" (F05, F06, F23, F30).
 *
 * Every path that grants a role — issuing or re-issuing an invitation, accepting one, changing one
 * member's role, the bulk assign — and the one path that removes the strongest grant of all
 * (offboarding) ask the same question, so they share this file rather than each carrying a copy
 * that drifts. `12-PERMISSION-MATRIX` §2 "Assign roles" names `owner` and `org_admin`; a delegated
 * custom role may grant a built-in role only when it already holds every capability that role
 * carries (the subset rule `mayGrantCapability` applies to custom roles), and only an owner makes
 * an owner (CQ-06).
 */

/**
 * platform-admin v2 · PA-01 (SPEC §3.3 footnote 4). Who may assign roles is now the capability
 * `roles.assign`, not a hard-coded role list: the owner and org_admin ceilings hold it (so
 * nothing changes for them), the Support-session role holds it, and a custom role or a member's
 * allow override may now hold it too — still bounded by the "only what you hold" subset rule in
 * {@link requireMayGrantRole}.
 */
export const ROLE_ASSIGN_CAPABILITY = 'roles.assign' as const;

/**
 * The built-in roles whose ceiling holds every capability (owner, org_admin, platform_support):
 * granting any built-in role never widens past them, so the subset walk is skipped for them.
 */
const FULL_CEILING_ROLES: ReadonlySet<string> = new Set(
  INTERNAL_ROLES.filter((role) =>
    CAPABILITIES.every((capability) => hasCapability(role, capability)),
  ),
);

/**
 * @deprecated PA-01 — use {@link isRoleAssigner} (the `roles.assign` capability). Kept, computed
 * from the ceiling, so callers that compare a role name keep compiling: the built-in roles whose
 * ceiling holds `roles.assign` (owner, org_admin, platform_support).
 */
export const ROLE_ASSIGNERS: readonly string[] = INTERNAL_ROLES.filter((role) =>
  hasCapability(role, ROLE_ASSIGN_CAPABILITY),
);

/** Same refusal text everywhere a role grant goes beyond the caller. */
export const ROLE_ESCALATION_MESSAGE = 'You can only give a role whose rights you hold yourself.';

export function isOwnerPrincipal(principal: Principal): boolean {
  return principal.kind === 'internal' && principal.role === 'owner';
}

/**
 * PA-01: may this principal assign roles at all? An internal principal that can exercise
 * `roles.assign` org-wide — role ceiling, custom role or allow override, minus a deny override,
 * under org policy — decided by the real evaluator.
 */
export function isRoleAssigner(principal: Principal): boolean {
  return (
    principal.kind === 'internal' &&
    mayGrantCapability(principal, ROLE_ASSIGN_CAPABILITY, principal.organizationId).allowed
  );
}

/** 403 unless the caller holds `roles.assign` (owner and org_admin always do). */
export function requireRoleAssigner(principal: Principal, action: string): void {
  if (!isRoleAssigner(principal)) {
    throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, `${action}.assigner`);
  }
}

/**
 * May `principal` grant the **built-in** `role`? (A custom role id is checked by its own subset
 * guard where it is resolved.) Refuses with 403 before any write:
 *
 * - `owner` — only an owner.
 * - an internal owner or organization admin — any other built-in role.
 * - anyone else — only when every capability of the role is one they could grant themselves.
 *   For a client principal (a client admin inviting into their own client organization) that is
 *   the plain ceiling subset, because the org-wide internal resource `mayGrantCapability`
 *   authorizes against is not theirs to reach.
 */
export function requireMayGrantRole(
  principal: Principal,
  role: string,
  organizationId: string,
  action: string,
): void {
  // PA-01: the Support-session role is written only by the support service, never granted.
  if (isPlatformSupportRole(role)) {
    throw new ApiError(
      403,
      'forbidden',
      MESSAGES.forbidden,
      [{ field: 'role', message: 'Choose another role.' }],
      `${action}:platform_support_not_assignable`,
    );
  }
  if (role === 'owner') {
    // PA-01 (SPEC §3.2): ownership can be transferred from inside a live Support session.
    if (isOwnerPrincipal(principal)) return;
    if (principal.kind === 'internal' && isPlatformSupportRole(principal.role)) return;
    throw new ApiError(
      403,
      'forbidden',
      'Only an owner can make someone an owner.',
      [{ field: 'role', message: 'Choose a role other than Owner.' }],
      `${action}:owner_only`,
    );
  }
  if (!isRole(role)) return;
  // A full-ceiling built-in assigner (owner, org_admin, platform_support) holds everything any
  // built-in role carries. Everyone else — a custom role or override holding `roles.assign`
  // included — passes the subset walk below (SPEC §3.3: "same subset rule").
  if (
    principal.kind === 'internal' &&
    FULL_CEILING_ROLES.has(principal.role) &&
    isRoleAssigner(principal)
  ) {
    return;
  }
  const held = capabilitySetFor(principal.role);
  for (const capability of capabilitiesFor(role)) {
    const allowed =
      principal.kind === 'client'
        ? held.has(capability)
        : mayGrantCapability(principal, capability, organizationId).allowed;
    if (!allowed) {
      throw new ApiError(
        403,
        'forbidden',
        ROLE_ESCALATION_MESSAGE,
        undefined,
        `${action}:role_escalation`,
      );
    }
  }
}

/**
 * 56-28 client ceiling: a role given to a client membership — or a custom role whose base is a
 * client role — may hold only `CLIENT_CAPABILITY_ALLOWLIST`. Anything else is a 422
 * `client_ceiling` whose details name each internal capability token, before any write.
 */
export function requireClientCeiling(
  role: PrincipalRole,
  capabilities: Iterable<Capability>,
  action: string,
): void {
  const outside = clientCeilingViolations(role, capabilities);
  if (outside.length === 0) return;
  const details = outside.map((capability) => ({ field: 'capabilities', message: capability }));
  const message = 'A client role can hold only client capabilities.';
  throw new ApiError(422, 'client_ceiling', message, details, `${action}:client_ceiling`);
}

/**
 * The capability set a **stored** role value grants: a built-in role's ceiling, a custom role's
 * row (resolved tenant-scoped), or nothing for anything else — deny by default.
 */
export async function capabilitiesOfStoredRole(
  runner: TenantQueryRunner,
  context: TenantContext,
  storedRole: string,
  customRoles: MemberBulkRoleRepository = new MemberBulkRoleRepository(),
): Promise<ReadonlySet<Capability>> {
  if (isRole(storedRole)) return new Set(capabilitiesFor(storedRole as Role));
  if (!isCustomRoleId(storedRole)) return new Set();
  const row = await customRoles.findRoleById(runner, context, storedRole);
  return new Set(row ? parseCustomRoleCapabilities(row.capabilitiesJson) : []);
}

/** Whether `target` holds any capability `caller` lacks (the subset rule, custom roles included). */
export function exceedsCaller(
  target: ReadonlySet<Capability>,
  caller: ReadonlySet<Capability>,
): boolean {
  return CAPABILITIES.some((capability) => target.has(capability) && !caller.has(capability));
}

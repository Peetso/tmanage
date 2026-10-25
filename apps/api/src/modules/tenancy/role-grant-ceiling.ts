import {
  capabilitiesFor,
  capabilitySetFor,
  CAPABILITIES,
  isCustomRoleId,
  isRole,
  mayGrantCapability,
  parseCustomRoleCapabilities,
} from '@tmanage/domain';
import type { Capability, Principal, Role } from '@tmanage/domain';
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

/** The roles that may assign roles at all (`12-PERMISSION-MATRIX` §2 "Assign roles"). */
export const ROLE_ASSIGNERS: readonly string[] = ['owner', 'org_admin'];

/** Same refusal text everywhere a role grant goes beyond the caller. */
export const ROLE_ESCALATION_MESSAGE = 'You can only give a role whose rights you hold yourself.';

export function isOwnerPrincipal(principal: Principal): boolean {
  return principal.kind === 'internal' && principal.role === 'owner';
}

export function isRoleAssigner(principal: Principal): boolean {
  return principal.kind === 'internal' && ROLE_ASSIGNERS.includes(principal.role);
}

/** 403 unless the caller is an internal owner or organization admin. */
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
  if (role === 'owner') {
    if (isOwnerPrincipal(principal)) return;
    throw new ApiError(
      403,
      'forbidden',
      'Only an owner can make someone an owner.',
      [{ field: 'role', message: 'Choose a role other than Owner.' }],
      `${action}:owner_only`,
    );
  }
  if (!isRole(role)) return;
  if (isRoleAssigner(principal)) return;
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

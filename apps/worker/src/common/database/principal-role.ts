import {
  customRoleKey,
  hasCapability,
  isCustomRoleId,
  isInternalRole,
  isRole,
  parseCustomRoleCapabilities,
} from '@tmanage/domain';
import type { Capability, PrincipalRole } from '@tmanage/domain';

/**
 * H1 — a raw `memberships.role` value turned into the principal role the domain checks.
 *
 * `memberships.role` holds a built-in role name or, since ADM-08, a custom role's id. The id says
 * nothing about what the role may do, so a bare `isRole(row.role)` check skipped every custom-role
 * member: they got no realtime frames, no direct-message socket, no notices. The API resolves the
 * id in `membership-resolver.repository.ts`; the worker reads raw rows, so it does the same here,
 * from the same tenant-scoped `custom_roles` row joined in the same statement.
 *
 * The rule is the resolver's: a built-in internal role is itself; a client role name on an
 * internal membership holds nothing (the resolver refuses it); a custom id holds exactly the
 * allowlisted capabilities its row in the **same organization** stores. Anything else, including
 * a raw value shaped like a principal key, holds nothing — deny by default.
 */

/**
 * The join every internal-membership read adds, aliasing the role row `cr`. The organization
 * predicate makes a role id from another tenant simply not match. `utf8mb4_unicode_ci` on both
 * columns compares case-insensitively, the same leniency the resolver's `toLowerCase()` gives.
 */
export function customRoleJoin(membershipAlias: string): string {
  return `LEFT JOIN custom_roles cr
         ON cr.organization_id = ${membershipAlias}.organization_id
        AND cr.id = ${membershipAlias}.role`;
}

/** The two columns {@link internalPrincipalRole} reads from the join. */
export const CUSTOM_ROLE_COLUMNS =
  'cr.id AS custom_role_id, cr.capabilities_json AS custom_role_capabilities';

/** The joined columns as a row carries them; absent on a row from a statement without the join. */
export interface CustomRoleColumns {
  readonly custom_role_id?: string | null;
  readonly custom_role_capabilities?: string | null;
}

/** The principal role an internal membership row holds, or null when it holds none. */
export function internalPrincipalRole(
  stored: string | null | undefined,
  columns: CustomRoleColumns = {},
): PrincipalRole | null {
  if (typeof stored !== 'string') return null;
  if (isInternalRole(stored)) return stored;
  if (isRole(stored)) return null;
  const id = stored.toLowerCase();
  const rowId = columns.custom_role_id;
  const json = columns.custom_role_capabilities;
  if (!isCustomRoleId(id) || typeof rowId !== 'string' || rowId.toLowerCase() !== id) return null;
  if (typeof json !== 'string') return null;
  return customRoleKey(id, parseCustomRoleCapabilities(json));
}

/** Does this resolved role hold the capability? A null role holds nothing. */
export function roleHolds(role: PrincipalRole | null, capability: Capability): boolean {
  return role !== null && hasCapability(role, capability);
}

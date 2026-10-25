import { hasCapability, isRole } from '@tmanage/domain';
import type { Capability } from '@tmanage/domain';

/**
 * H1 — may the signed-in person's role use a capability, for drawing a page or a menu entry?
 *
 * A built-in role answers from the domain's own ceiling table. A custom role's stored value is its
 * id, which says nothing, so the organization list carries the role's loaded `capabilities` and
 * that set answers instead. Anything else answers no. Never an authorization: the API decides
 * every request; this only stops offering pages that would refuse the person.
 */
export function roleMayUse(
  role: string | undefined,
  capabilities: readonly string[] | undefined,
  capability: Capability,
): boolean {
  if (role === undefined) return false;
  if (isRole(role)) return hasCapability(role, capability);
  return capabilities?.includes(capability) ?? false;
}

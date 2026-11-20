import { capabilitySetFor, mayActOnMember, memberAuthorityTier } from '@tmanage/domain';
import type { MemberAuthorityTier, Principal } from '@tmanage/domain';
import { ApiError } from '../../common/http/errors.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';
import { MemberBulkRoleRepository } from './member-bulk-role.repository.js';
import { capabilitiesOfStoredRole } from './role-grant-ceiling.js';

/**
 * QA-FIX-P S3 — the API's one entry to the domain's "who may act on whom" rule
 * (`@tmanage/domain` `mayActOnMember`), for every member-management write: password reset,
 * ending sessions, role change (single and bulk) and offboarding.
 *
 * The actor's tier is read from its role and the resolved context's capabilities; the
 * target's from its stored role, a custom role resolved tenant-scoped to the set its row grants.
 */
export const MEMBER_RANK_MESSAGE =
  'Only an owner can do this to an owner or an organization admin.';

export function actorTier(principal: Principal, context: TenantContext): MemberAuthorityTier {
  if (principal.kind !== 'internal') return 'member';
  // The role's own set plus what the resolved context carries (an override can add
  // `org.manage`; a denying override never reaches these routes, which need it to pass the guard).
  const held = new Set([...capabilitySetFor(principal.role), ...(context.capabilities ?? [])]);
  return memberAuthorityTier(principal.role, held);
}

export async function targetTier(
  runner: TenantQueryRunner,
  context: TenantContext,
  storedRole: string,
  customRoles: MemberBulkRoleRepository = new MemberBulkRoleRepository(),
): Promise<MemberAuthorityTier> {
  if (storedRole === 'owner') return 'owner';
  const capabilities = await capabilitiesOfStoredRole(runner, context, storedRole, customRoles);
  return memberAuthorityTier(storedRole, capabilities);
}

/** 403 with no write when the actor does not outrank the target. */
export async function requireMayActOnMember(
  runner: TenantQueryRunner,
  context: TenantContext,
  principal: Principal,
  storedRole: string,
  action: string,
  customRoles?: MemberBulkRoleRepository,
): Promise<void> {
  const target = await targetTier(runner, context, storedRole, customRoles);
  if (!mayActOnMember(actorTier(principal, context), target)) {
    throw new ApiError(403, 'forbidden', MEMBER_RANK_MESSAGE, undefined, `${action}:member_rank`);
  }
}

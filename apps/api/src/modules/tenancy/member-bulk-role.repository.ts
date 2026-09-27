import { and, eq, sql } from 'drizzle-orm';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { customRoles, memberships } from '../../common/database/schema.js';
import type { CustomRoleRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * The data half of admin bulk role assignment (Administration module 18, x222) — no new table. It
 * reuses `custom_roles` (x173) as the assignable role and `memberships` (the row a person's authority
 * hangs on) as the write target, and every query carries an `organization_id = context.organizationId`
 * predicate. That predicate is the whole tenant-isolation story here: a role in another studio resolves
 * to nothing (a 404 the controller raises before any write), and a membership in another studio matches
 * no row on UPDATE (reported not-found for that id, never applied, never a 500 or a cross-tenant leak).
 *
 * The driver handle lives here rather than in the controller or a service because
 * `25-AUTH-AND-TENANT-ISOLATION` §6 (and the `no-restricted-imports` lint boundary) keep drizzle inside
 * `*.repository.ts`. Feature code takes a `TenantQueryRunner` from `TenantDatabase.transaction()`.
 */
export class MemberBulkRoleRepository {
  /**
   * One custom role by id for the acting tenant, if present — the resolve-before-authorize step. A role
   * in another tenant, or no role, resolves to `undefined` (the controller turns that into a 404 with no
   * write, so a cross-tenant id is indistinguishable from an unknown one). Scoped on
   * `(organization_id, id)`, the columns `uq_custom_roles_org_id` covers.
   */
  async findRoleById(
    runner: TenantQueryRunner,
    context: TenantContext,
    roleId: string,
  ): Promise<CustomRoleRow | undefined> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(customRoles)
      .where(
        and(eq(customRoles.organizationId, context.organizationId), eq(customRoles.id, roleId)),
      )
      .limit(1);
    return rows[0];
  }

  /**
   * Assign the role to one membership for the acting tenant. Returns whether a row was written: a
   * membership belonging to another tenant (or no membership at all) matches nothing under the
   * `(organization_id, id)` predicate, so `affectedRows` is 0 and the controller reports that id
   * not-found without ever revealing whether it exists elsewhere.
   *
   * Two epoch tokens move on a role change, exactly as `MembershipsRepository.changeRole` does for a
   * single assign: `version` (optimistic-concurrency) and `policy_version` (the authorization epoch that
   * `24-CACHING` keys on, so a context minted before the change is rotated). `has_org_wide_scope` and the
   * workspace scope are left untouched — a role change must not silently widen or narrow reach.
   */
  async assignRole(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
    roleId: string,
  ): Promise<boolean> {
    const result = await tenantDrizzle(runner)
      .update(memberships)
      .set({
        role: roleId,
        version: sql`version + 1`,
        policyVersion: sql`policy_version + 1`,
        updatedAt: sql`current_timestamp(3)`,
      })
      .where(
        and(
          eq(memberships.organizationId, context.organizationId),
          eq(memberships.id, membershipId),
        ),
      );
    return result[0].affectedRows > 0;
  }
}

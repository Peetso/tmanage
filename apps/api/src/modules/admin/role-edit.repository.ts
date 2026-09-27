import { and, eq, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { customRoles } from '../../common/database/schema.js';
import type { CustomRoleRow } from '../../common/database/schema.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * The data half of custom role clone + edit (Administration module 18, x195). Reuses the `custom_roles`
 * table x173 owns; every query carries an `organization_id = context.organizationId` predicate, so the
 * addressed role is resolved, renamed and re-capabilitied only within the acting tenant — another
 * studio's role can never be read or written. Clone reuses INSERT (already granted); edit needs UPDATE
 * (added to `users.sql` by x195). Kept a separate module from `role-edit.controller.ts` so the driver
 * handle lives where the tenancy rules allow it (`25-AUTH-AND-TENANT-ISOLATION` §6).
 */
export class RoleEditRepository {
  /**
   * One role by id for the acting tenant, if present — the resolve-before-authorize step. A role in
   * another tenant, or no role, resolves to `undefined` (the controller turns that into a 404 with no
   * write). Scoped on `(organization_id, id)`, the same columns `uq_custom_roles_org_id` covers.
   */
  async findById(
    runner: TenantQueryRunner,
    context: TenantContext,
    id: string,
  ): Promise<CustomRoleRow | undefined> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(customRoles)
      .where(and(eq(customRoles.organizationId, context.organizationId), eq(customRoles.id, id)))
      .limit(1);
    return rows[0];
  }

  /** One role by name for the acting tenant, if present — the duplicate-name (409) check. */
  async findByName(
    runner: TenantQueryRunner,
    context: TenantContext,
    name: string,
  ): Promise<CustomRoleRow | undefined> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(customRoles)
      .where(
        and(eq(customRoles.organizationId, context.organizationId), eq(customRoles.name, name)),
      )
      .limit(1);
    return rows[0];
  }

  /**
   * Insert one role for the acting tenant (the clone). `capabilities` is the already-validated subset —
   * the controller has proved every string is allowlisted and exercisable by the caller — stored as a
   * JSON array of strings. Returns the inserted row projected for the response.
   */
  async insert(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: {
      readonly name: string;
      readonly capabilities: readonly string[];
      readonly createdBy: string;
    },
  ): Promise<CustomRoleRow> {
    const id = uuidv7();
    const createdAt = new Date();
    await tenantDrizzle(runner)
      .insert(customRoles)
      .values({
        id,
        organizationId: context.organizationId,
        name: input.name,
        capabilitiesJson: JSON.stringify(input.capabilities),
        createdBy: input.createdBy,
        createdAt: sql`current_timestamp(3)`,
      });
    return {
      id,
      organizationId: context.organizationId,
      name: input.name,
      capabilitiesJson: JSON.stringify(input.capabilities),
      createdBy: input.createdBy,
      createdAt,
    };
  }

  /**
   * Update one role's name and capability subset for the acting tenant (the edit). Scoped on
   * `(organization_id, id)`, so a role in another tenant is never touched (the controller has already
   * resolved the id tenant-scoped). Returns the updated row projected for the response.
   */
  async update(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: {
      readonly id: string;
      readonly name: string;
      readonly capabilities: readonly string[];
    },
  ): Promise<CustomRoleRow> {
    const capabilitiesJson = JSON.stringify(input.capabilities);
    await tenantDrizzle(runner)
      .update(customRoles)
      .set({ name: input.name, capabilitiesJson })
      .where(
        and(eq(customRoles.organizationId, context.organizationId), eq(customRoles.id, input.id)),
      );
    const rows = await tenantDrizzle(runner)
      .select()
      .from(customRoles)
      .where(
        and(eq(customRoles.organizationId, context.organizationId), eq(customRoles.id, input.id)),
      )
      .limit(1);
    const row = rows[0];
    if (!row) throw new ApiError(404, 'not_found', MESSAGES.notFound);
    return row;
  }
}

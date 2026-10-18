import { and, asc, eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { customRoles, organizations } from '../../common/database/schema.js';
import type { CustomRoleRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * The data half of custom roles (Administration module 18, x173) — the tenant-scoped reads and the
 * insert the roles routes depend on. It owns the `custom_roles` table alone, so the roles surface stays
 * file-disjoint from `org-settings.repository.ts` (x153) and the tenancy repositories.
 *
 * ## Every query is scoped to the acting tenant
 *
 * Both the list and the duplicate-name lookup carry an `organization_id = context.organizationId`
 * predicate, so another studio's roles are never read, and the insert stamps the acting tenant, so a
 * role can never be created for another studio. The controller resolves the organization tenant-scoped
 * (via {@link resolveOrganization}) before it authorizes or writes, so a context naming an organization
 * that does not exist in this tenant is a 404 with no write.
 */
export class CustomRolesRepository {
  /**
   * The acting organization's id, if it exists in this tenant — otherwise `undefined`. The
   * resolve-before-authorize step: a context whose organization does not resolve is a 404 with no
   * authorize and no write, never a dangling insert.
   */
  async resolveOrganization(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<{ readonly id: string } | undefined> {
    const rows = await tenantDrizzle(runner)
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.id, context.organizationId))
      .limit(1);
    return rows[0];
  }

  /** Every custom role for the acting tenant, oldest name first. */
  async listAll(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<readonly CustomRoleRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(customRoles)
      .where(eq(customRoles.organizationId, context.organizationId))
      .orderBy(asc(customRoles.name));
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
   * Insert one custom role for the acting tenant. `capabilities` is the already-validated subset of the
   * allowlist (the controller has proved every string is an allowlisted capability the caller holds);
   * it is stored as a JSON array of strings.
   */
  async insert(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: {
      readonly name: string;
      readonly capabilities: readonly string[];
      readonly createdBy: string;
    },
  ): Promise<string> {
    const id = uuidv7();
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
    return id;
  }
}

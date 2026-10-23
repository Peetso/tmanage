import { and, eq, sql } from 'drizzle-orm';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { fileAssets, organizations } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * A11 — the organization's own profile on the Organization settings card: its name and its logo.
 *
 * Every statement anchors on `organizations.id = context.organizationId` (that table's tenant key
 * is `id`), so there is no way to read or change another organization's row from here. The logo is
 * the id of a `file_assets` row; {@link findLogoAsset} reads that row only inside this tenant.
 */
export interface OrganizationProfileRow {
  readonly name: string;
  readonly logoFileId: string | null;
}

export interface LogoAssetRow {
  readonly id: string;
  readonly purpose: string;
  readonly status: string;
}

export class OrganizationProfileRepository {
  async find(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<OrganizationProfileRow | undefined> {
    const rows = await tenantDrizzle(runner)
      .select({ name: organizations.name, logoFileId: organizations.logoFileId })
      .from(organizations)
      .where(eq(organizations.id, context.organizationId))
      .limit(1);
    return rows[0];
  }

  async rename(runner: TenantQueryRunner, context: TenantContext, name: string): Promise<void> {
    await tenantDrizzle(runner)
      .update(organizations)
      .set({ name, updatedAt: sql`current_timestamp(3)` })
      .where(eq(organizations.id, context.organizationId));
  }

  async setLogo(
    runner: TenantQueryRunner,
    context: TenantContext,
    logoFileId: string | null,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .update(organizations)
      .set({ logoFileId, updatedAt: sql`current_timestamp(3)` })
      .where(eq(organizations.id, context.organizationId));
  }

  /** The file asset named as the new logo, if it is this tenant's. */
  async findLogoAsset(
    runner: TenantQueryRunner,
    context: TenantContext,
    fileAssetId: string,
  ): Promise<LogoAssetRow | undefined> {
    const rows = await tenantDrizzle(runner)
      .select({ id: fileAssets.id, purpose: fileAssets.purpose, status: fileAssets.status })
      .from(fileAssets)
      .where(
        and(eq(fileAssets.organizationId, context.organizationId), eq(fileAssets.id, fileAssetId)),
      )
      .limit(1);
    return rows[0];
  }
}

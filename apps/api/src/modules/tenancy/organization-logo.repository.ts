import { eq, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { organizationLogos, organizations } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * C6 — the company logo's own table (`organization_logos`, 0229). Every statement carries
 * `organization_id = context.organizationId`; the organization id is never taken from a body.
 * {@link findInfo} leaves the image column out, so reading whether a logo exists never loads it.
 */
export interface OrganizationLogoInfo {
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly version: number;
  readonly updatedAt: Date;
}

export interface OrganizationLogoImage extends OrganizationLogoInfo {
  readonly sha256: string;
  readonly contentBase64: string;
}

export interface OrganizationLogoInput {
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly contentBase64: string;
}

export class OrganizationLogoRepository {
  async findInfo(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<OrganizationLogoInfo | null> {
    const rows = await tenantDrizzle(runner)
      .select({
        mimeType: organizationLogos.mimeType,
        sizeBytes: organizationLogos.sizeBytes,
        version: organizationLogos.version,
        updatedAt: organizationLogos.updatedAt,
      })
      .from(organizationLogos)
      .where(eq(organizationLogos.organizationId, context.organizationId))
      .limit(1);
    return rows[0] ?? null;
  }

  async findImage(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<OrganizationLogoImage | null> {
    const rows = await tenantDrizzle(runner)
      .select({
        mimeType: organizationLogos.mimeType,
        sizeBytes: organizationLogos.sizeBytes,
        version: organizationLogos.version,
        updatedAt: organizationLogos.updatedAt,
        sha256: organizationLogos.sha256,
        contentBase64: organizationLogos.contentBase64,
      })
      .from(organizationLogos)
      .where(eq(organizationLogos.organizationId, context.organizationId))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Create or replace the logo — one statement on the `(organization_id)` key, so two uploads
   * racing serialise on the key. The old-style file logo (`organizations.logo_file_id`, 0224) is
   * cleared in the same transaction, so there is only ever one logo.
   */
  async upsert(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: OrganizationLogoInput,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .insert(organizationLogos)
      .values({
        id: uuidv7(),
        organizationId: context.organizationId,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
        sha256: input.sha256,
        contentBase64: input.contentBase64,
        version: 1,
        updatedBy: context.userId,
        createdAt: sql`current_timestamp(3)`,
        updatedAt: sql`current_timestamp(3)`,
      })
      .onDuplicateKeyUpdate({
        set: {
          mimeType: input.mimeType,
          sizeBytes: input.sizeBytes,
          sha256: input.sha256,
          contentBase64: input.contentBase64,
          version: sql`version + 1`,
          updatedBy: context.userId,
        },
      });
    await this.clearFileLogo(runner, context);
  }

  /** Remove the logo (both kinds). Idempotent. */
  async remove(runner: TenantQueryRunner, context: TenantContext): Promise<void> {
    await tenantDrizzle(runner)
      .delete(organizationLogos)
      .where(eq(organizationLogos.organizationId, context.organizationId));
    await this.clearFileLogo(runner, context);
  }

  private async clearFileLogo(runner: TenantQueryRunner, context: TenantContext): Promise<void> {
    await tenantDrizzle(runner)
      .update(organizations)
      .set({ logoFileId: null, updatedAt: sql`current_timestamp(3)` })
      .where(eq(organizations.id, context.organizationId));
  }
}

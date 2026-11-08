import { and, eq, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { templatePacks } from '../../common/database/schema.js';
import type { TemplatePackRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * 54-22. The installed-packs record (0325). Every method takes the runner and the context first and
 * puts the tenant predicate on every statement; `organization_id` always comes from the context.
 */
export class TemplatePacksRepository {
  /** The packs this organization has installed. */
  async listInstalled(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<readonly TemplatePackRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(templatePacks)
      .where(eq(templatePacks.organizationId, context.organizationId));
  }

  async findByKey(
    runner: TenantQueryRunner,
    context: TenantContext,
    packKey: string,
  ): Promise<TemplatePackRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(templatePacks)
      .where(
        and(
          eq(templatePacks.organizationId, context.organizationId),
          eq(templatePacks.packKey, packKey),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** Record an install. `uq_template_packs_org_pack` is the backstop for a racing second install. */
  async recordInstall(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: { readonly packKey: string; readonly templatesCreated: number },
  ): Promise<void> {
    await tenantDrizzle(runner)
      .insert(templatePacks)
      .values({
        id: uuidv7(),
        organizationId: context.organizationId,
        packKey: input.packKey,
        templatesCreated: input.templatesCreated,
        installedBy: context.userId,
        installedAt: sql`current_timestamp(3)`,
      });
  }
}

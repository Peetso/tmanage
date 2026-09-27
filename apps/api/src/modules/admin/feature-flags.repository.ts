import { and, eq, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { orgFeatureFlags } from '../../common/database/schema.js';
import type { OrgFeatureFlagRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * The data half of per-org optional-module feature flags (Administration module 18, x278). Every
 * query carries an `organization_id = context.organizationId` predicate, so a flag is listed, read
 * and upserted only within the acting tenant — another studio's module configuration can never be
 * read or written. The set (org.manage) and the resolved read (work.read) both go through here.
 *
 * ## The write is one upsert, not a read-then-write
 *
 * {@link upsert} is a single `INSERT ... ON DUPLICATE KEY UPDATE` against
 * `uq_org_feature_flags_org_key`. Two saves racing for one flag serialise on the unique key rather
 * than on a row this code read first, so a lost update is not expressible. The insert path fills
 * `id`; the update path leaves it alone and moves only `enabled` and `updated_by`, and `updated_at`
 * follows by the column's `ON UPDATE`. Validation that `flag_key` is on the allowlist is the
 * controller's; this store persists what it is given.
 */
export class FeatureFlagsRepository {
  /** Every stored flag row for the acting tenant — the admin list and the resolved read fold over this. */
  async list(runner: TenantQueryRunner, context: TenantContext): Promise<OrgFeatureFlagRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(orgFeatureFlags)
      .where(eq(orgFeatureFlags.organizationId, context.organizationId));
  }

  /** One flag by key for the acting tenant, if present. Scoped on `(organization_id, flag_key)`. */
  async findByKey(
    runner: TenantQueryRunner,
    context: TenantContext,
    flagKey: string,
  ): Promise<OrgFeatureFlagRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(orgFeatureFlags)
      .where(
        and(
          eq(orgFeatureFlags.organizationId, context.organizationId),
          eq(orgFeatureFlags.flagKey, flagKey),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Create or replace one flag's state for the acting tenant. Idempotent by the unique key; the
   * `flagKey` has already been proved on the allowlist by the controller. Returns the resulting row.
   */
  async upsert(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: { readonly flagKey: string; readonly enabled: boolean; readonly updatedBy: string },
  ): Promise<OrgFeatureFlagRow> {
    await tenantDrizzle(runner)
      .insert(orgFeatureFlags)
      .values({
        id: uuidv7(),
        organizationId: context.organizationId,
        flagKey: input.flagKey,
        enabled: input.enabled,
        updatedBy: input.updatedBy,
        updatedAt: sql`current_timestamp(3)`,
      })
      .onDuplicateKeyUpdate({
        set: { enabled: input.enabled, updatedBy: input.updatedBy },
      });
    const row = await this.findByKey(runner, context, input.flagKey);
    // The upsert guarantees a row for this key in this tenant; the read is scoped identically.
    return row!;
  }
}

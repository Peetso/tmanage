import { and, eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { organizations, orgSettings } from '../../common/database/schema.js';
import type { OrgSettingRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';
import type { OrgSettingKey } from './org-settings.allowlist.js';

/**
 * The data half of organization settings (x153) — the tenant-scoped reads and the upsert the PUT
 * depends on. Distinct from `organizations.repository.ts`: this owns the `org_settings` table alone,
 * so the settings surface stays file-disjoint from the organization-profile repository.
 *
 * ## Every query is scoped to the acting tenant
 *
 * Both reads and the upsert carry an `organization_id = context.organizationId` predicate, so a
 * settings row of another studio is never read or overwritten. The controller resolves the
 * organization tenant-scoped (via {@link resolveOrganization}) before it authorizes or writes, so a
 * context naming an organization that does not exist in this tenant is a 404 with no write.
 */
export class OrgSettingsRepository {
  /**
   * The acting organization's id, if it exists in this tenant — otherwise `undefined`. The
   * resolve-before-authorize step: a context whose organization does not resolve is a 404 with no
   * authorize and no write, never a 500 on a dangling upsert.
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

  /** Every stored settings row for the acting tenant. Merged with the allowlist defaults by the caller. */
  async listAll(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<readonly OrgSettingRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(orgSettings)
      .where(eq(orgSettings.organizationId, context.organizationId));
  }

  /**
   * Set one allowlisted key to a canonical value, upserting on `(organization_id, setting_key)`: a
   * first write inserts, a re-set overwrites the value (and who set it, and when) in place. `id`,
   * `organization_id` and `setting_key` are never changed on the update path — the 0058 trigger holds
   * the last two immutable besides.
   */
  async upsert(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: { readonly key: OrgSettingKey; readonly value: string; readonly updatedBy: string },
  ): Promise<void> {
    await tenantDrizzle(runner)
      .insert(orgSettings)
      .values({
        id: uuidv7(),
        organizationId: context.organizationId,
        settingKey: input.key,
        settingValue: input.value,
        updatedBy: input.updatedBy,
        createdAt: sql`current_timestamp(3)`,
        updatedAt: sql`current_timestamp(3)`,
      })
      .onDuplicateKeyUpdate({
        set: {
          settingValue: input.value,
          updatedBy: input.updatedBy,
          updatedAt: sql`current_timestamp(3)`,
        },
      });
  }

  /** One stored key for the acting tenant, if written — the read-back after an upsert. */
  async findByKey(
    runner: TenantQueryRunner,
    context: TenantContext,
    key: OrgSettingKey,
  ): Promise<OrgSettingRow | undefined> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(orgSettings)
      .where(
        and(
          eq(orgSettings.organizationId, context.organizationId),
          eq(orgSettings.settingKey, key),
        ),
      )
      .limit(1);
    return rows[0];
  }
}

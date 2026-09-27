import { eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { organizations, securitySettings } from '../../common/database/schema.js';
import type { SecuritySettingsRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * The data half of the organization security settings (Administration module 18, x176) — the
 * tenant-scoped read and the one-row-per-organization upsert the security screen depends on. It owns
 * the `security_settings` table alone, so the security surface stays file-disjoint from the
 * org-settings (x153) and audit (x115) repositories in the same module.
 *
 * ## Every query is scoped to the acting tenant
 *
 * The read and the upsert both carry an `organization_id = context.organizationId` predicate, so
 * another studio's security posture is never read or overwritten. The controller resolves the
 * organization tenant-scoped (via {@link resolveOrganization}) before it authorizes or writes, so a
 * context naming an organization that does not exist in this tenant is a 404 with no write.
 */
export class SecuritySettingsRepository {
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

  /** The acting tenant's security settings row, if one has been written — otherwise `undefined` (defaults). */
  async find(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<SecuritySettingsRow | undefined> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(securitySettings)
      .where(eq(securitySettings.organizationId, context.organizationId))
      .limit(1);
    return rows[0];
  }

  /**
   * Upsert the acting tenant's security settings, one row per organization: a first write inserts, a
   * re-save overwrites `enforce_2fa`, the allowlist, and who set it and when, in place. `id` and
   * `organization_id` are never changed on the update path — the 0073 trigger holds `organization_id`
   * immutable at the engine besides.
   */
  async upsert(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: {
      readonly enforce2fa: boolean;
      readonly ipAllowlist: readonly string[];
      readonly updatedBy: string;
    },
  ): Promise<void> {
    await tenantDrizzle(runner)
      .insert(securitySettings)
      .values({
        id: uuidv7(),
        organizationId: context.organizationId,
        enforce2fa: input.enforce2fa,
        ipAllowlistJson: input.ipAllowlist,
        updatedBy: input.updatedBy,
        createdAt: sql`current_timestamp(3)`,
        updatedAt: sql`current_timestamp(3)`,
      })
      .onDuplicateKeyUpdate({
        set: {
          enforce2fa: input.enforce2fa,
          ipAllowlistJson: input.ipAllowlist,
          updatedBy: input.updatedBy,
          updatedAt: sql`current_timestamp(3)`,
        },
      });
  }
}

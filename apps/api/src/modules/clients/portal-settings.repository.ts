import { and, eq, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { portalSettings } from '../../common/database/schema.js';
import type { PortalSettingsRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * The portal-settings repository — SEC / Client portal (module 13, x238), following the
 * `notification_preferences` (0022) read/upsert posture exactly.
 *
 * `25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md` §6 is honoured structurally:
 *
 * 1. **No unscoped read/write.** Every method's first two parameters are the `TenantQueryRunner`
 *    for the current unit of work and the `TenantContext`. There is no overload without a context,
 *    so a caller that never established a tenant is a type error.
 * 2. **The tenant comes from the context, never the DTO.** {@link PortalSettingsInput} has no
 *    `organizationId` field, so a request body cannot choose the tenant it writes into.
 * 3. **The tenant predicate is on every statement**, built with Drizzle and executed through the
 *    guard (`drizzle.ts`), so a forgotten predicate throws rather than leaking rows.
 *
 * The write is a single `INSERT ... ON DUPLICATE KEY UPDATE` against
 * `uq_portal_settings_org_project`: two saves racing for one project's row serialise on the unique
 * key rather than on a row this code read first, so a lost update is not expressible. The insert path
 * fills `id` and the create timestamp; the update path leaves both (and `project_id`) alone and moves
 * only the settings and the `updated_by` stamp, and `updated_at` follows by the column's `ON UPDATE`.
 */

/**
 * The settings a caller can set — the presentation columns plus who saved them. Note what is absent:
 * `organizationId` and `projectId` come from the context and the path, so there is no field for a
 * request body to populate.
 */
export interface PortalSettingsInput {
  readonly welcomeMessage: string | null;
  readonly accentColor: string;
  readonly showTeam: boolean;
  readonly showTimeline: boolean;
  /** The person saving the settings — the service passes `context.userId`. */
  readonly updatedBy: string;
}

export class PortalSettingsRepository {
  /**
   * Fetch one project's portal settings, within the acting tenant. Returns `null` when the project
   * has never been configured — the service fills defaults, so "never configured" and "saved the
   * defaults" are one behaviour.
   */
  async findForProject(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectId: string,
  ): Promise<PortalSettingsRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(portalSettings)
      .where(
        and(
          eq(portalSettings.organizationId, context.organizationId),
          eq(portalSettings.projectId, projectId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Create or replace one project's portal settings in this studio. Idempotent by the unique
   * `(organization_id, project_id)` key. `organization_id` comes from the context, never from `input`.
   */
  async upsert(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectId: string,
    input: PortalSettingsInput,
  ): Promise<PortalSettingsRow> {
    await tenantDrizzle(runner)
      .insert(portalSettings)
      .values({
        id: uuidv7(),
        organizationId: context.organizationId,
        projectId,
        welcomeMessage: input.welcomeMessage,
        accentColor: input.accentColor,
        showTeam: input.showTeam,
        showTimeline: input.showTimeline,
        updatedBy: input.updatedBy,
        createdAt: sql`current_timestamp(3)`,
        updatedAt: sql`current_timestamp(3)`,
      })
      .onDuplicateKeyUpdate({
        set: {
          welcomeMessage: input.welcomeMessage,
          accentColor: input.accentColor,
          showTeam: input.showTeam,
          showTimeline: input.showTimeline,
          updatedBy: input.updatedBy,
        },
      });

    // Read back rather than reconstruct: the row now carries server-generated timestamps and, on the
    // update path, the pre-existing `id`/`created_at`.
    const row = await this.findForProject(runner, context, projectId);
    if (!row) throw new Error(`portal settings for project ${projectId} vanished after upsert`);
    return row;
  }
}

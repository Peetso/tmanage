import { and, eq, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { portalBranding } from '../../common/database/schema.js';
import type { PortalBrandingRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * The portal-branding repository — SEC / Client portal (module 13, x323), following the
 * `portal_settings` (0110) read/upsert posture exactly, but keyed per **client organization**.
 *
 * `25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md` §6 is honoured structurally:
 *
 * 1. **No unscoped read/write.** Every method takes the `TenantQueryRunner` and the `TenantContext`
 *    first; there is no overload without a context.
 * 2. **The tenant comes from the context, never the DTO.** {@link PortalBrandingInput} has no
 *    `organizationId` field, so a request body cannot choose the tenant it writes into.
 * 3. **The tenant predicate is on every statement**, executed through the guard (`drizzle.ts`).
 *
 * The write is a single `INSERT ... ON DUPLICATE KEY UPDATE` against `uq_portal_branding_org_client`:
 * two saves racing for one client's row serialise on the unique key rather than on a row this code
 * read first, so a lost update is not expressible. The insert path fills `id` and the create
 * timestamp; the update path leaves both (and `client_org_scope_id`) alone and moves only the branding
 * substance and the `updated_by` stamp, and `updated_at` follows by the column's `ON UPDATE`.
 */
export interface PortalBrandingInput {
  readonly accentColor: string;
  readonly welcomeHeading: string | null;
  readonly welcomeText: string | null;
  /** The person saving the branding — the service passes `context.userId`. */
  readonly updatedBy: string;
}

export class PortalBrandingRepository {
  /**
   * Fetch one client organization's branding, within the acting tenant. Returns `null` when the
   * client has never been branded — the service fills defaults, so "never branded" and "saved the
   * defaults" are one behaviour.
   */
  async findForClientOrg(
    runner: TenantQueryRunner,
    context: TenantContext,
    clientOrgScopeId: string,
  ): Promise<PortalBrandingRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(portalBranding)
      .where(
        and(
          eq(portalBranding.organizationId, context.organizationId),
          eq(portalBranding.clientOrgScopeId, clientOrgScopeId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Create or replace one client organization's branding in this studio. Idempotent by the unique
   * `(organization_id, client_org_scope_id)` key. `organization_id` comes from the context, never from
   * `input`.
   */
  async upsert(
    runner: TenantQueryRunner,
    context: TenantContext,
    clientOrgScopeId: string,
    input: PortalBrandingInput,
  ): Promise<PortalBrandingRow> {
    await tenantDrizzle(runner)
      .insert(portalBranding)
      .values({
        id: uuidv7(),
        organizationId: context.organizationId,
        clientOrgScopeId,
        accentColor: input.accentColor,
        welcomeHeading: input.welcomeHeading,
        welcomeText: input.welcomeText,
        updatedBy: input.updatedBy,
        createdAt: sql`current_timestamp(3)`,
        updatedAt: sql`current_timestamp(3)`,
      })
      .onDuplicateKeyUpdate({
        set: {
          accentColor: input.accentColor,
          welcomeHeading: input.welcomeHeading,
          welcomeText: input.welcomeText,
          updatedBy: input.updatedBy,
        },
      });

    // Read back rather than reconstruct: the row now carries server-generated timestamps and, on the
    // update path, the pre-existing `id`/`created_at`.
    const row = await this.findForClientOrg(runner, context, clientOrgScopeId);
    if (!row)
      throw new Error(`portal branding for client ${clientOrgScopeId} vanished after upsert`);
    return row;
  }
}

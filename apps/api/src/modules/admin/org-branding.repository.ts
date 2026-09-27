import { eq, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { orgBranding, organizations } from '../../common/database/schema.js';
import type { OrgBrandingRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * The data half of ADM / org identity (Administration, module 18, x327) — the tenant-scoped read and
 * the upsert the org-branding routes depend on. It owns the `org_branding` table alone, so the surface
 * stays file-disjoint from the other admin repositories.
 *
 * ## Every query is scoped to the acting tenant
 *
 * Both statements carry an `organization_id = context.organizationId` predicate, so another studio's
 * branding is never read and a branding row can never be written for another studio. The upsert stamps
 * the acting tenant from the context, never from a DTO. The write is a single
 * `INSERT ... ON DUPLICATE KEY UPDATE` against `uq_org_branding_org`, so two saves racing for one
 * studio's row serialise on the unique key rather than on a row this code read first — a lost update is
 * not expressible. The insert path fills `id` and the create timestamp; the update path leaves both
 * (and `organization_id`) alone and moves only the branding columns and the `updated_by` stamp.
 *
 * A branding row is created (INSERT) and replaced (UPDATE) only — the runtime credential holds no
 * DELETE. Reading is the database-wide SELECT.
 */

/**
 * The branding a caller can set — the presentation columns plus who saved them. Note what is absent:
 * `organizationId` comes from the context, so there is no field for a request body to populate.
 */
export interface OrgBrandingInput {
  readonly productName: string | null;
  readonly accentColor: string;
  readonly logoText: string | null;
  /** The person saving the branding — the service passes `context.userId`. */
  readonly updatedBy: string;
}

export class OrgBrandingRepository {
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

  /**
   * Fetch the acting studio's branding, within the acting tenant. Returns `null` when the studio has
   * never configured its branding — the service fills defaults, so "never configured" and "saved the
   * defaults" are one behaviour.
   */
  async findForOrganization(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<OrgBrandingRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(orgBranding)
      .where(eq(orgBranding.organizationId, context.organizationId))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Create or replace the acting studio's branding. Idempotent by the unique `(organization_id)` key.
   * `organization_id` comes from the context, never from `input`.
   */
  async upsert(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: OrgBrandingInput,
  ): Promise<OrgBrandingRow> {
    await tenantDrizzle(runner)
      .insert(orgBranding)
      .values({
        id: uuidv7(),
        organizationId: context.organizationId,
        productName: input.productName,
        accentColor: input.accentColor,
        logoText: input.logoText,
        updatedBy: input.updatedBy,
        createdAt: sql`current_timestamp(3)`,
        updatedAt: sql`current_timestamp(3)`,
      })
      .onDuplicateKeyUpdate({
        set: {
          productName: input.productName,
          accentColor: input.accentColor,
          logoText: input.logoText,
          updatedBy: input.updatedBy,
        },
      });

    // Read back rather than reconstruct: the row now carries server-generated timestamps and, on the
    // update path, the pre-existing `id`/`created_at`.
    const row = await this.findForOrganization(runner, context);
    if (!row) throw new Error('org branding vanished after upsert');
    return row;
  }
}

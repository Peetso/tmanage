import { eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { organizations, orgPolicies } from '../../common/database/schema.js';
import type { OrgPolicyRow, OrgPolicyValue } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * The data half of organization access policies (x174) — the tenant-scoped read and the upsert the PUT
 * depends on. Distinct from `org-settings.repository.ts` (x153): this owns the `org_policies` table
 * alone, so the access-policy surface stays file-disjoint from the general-settings repository.
 *
 * ## Every query is scoped to the acting tenant
 *
 * Both the read and the upsert carry an `organization_id = context.organizationId` predicate, so a
 * policy row of another studio is never read or overwritten. The controller resolves the organization
 * tenant-scoped (via {@link resolveOrganization}) before it authorizes or writes, so a context naming
 * an organization that does not exist in this tenant is a 404 with no write.
 */
export class PoliciesRepository {
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

  /** The acting tenant's policy row, if one has been written. Merged with the defaults by the caller. */
  async find(runner: TenantQueryRunner, context: TenantContext): Promise<OrgPolicyRow | undefined> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(orgPolicies)
      .where(eq(orgPolicies.organizationId, context.organizationId))
      .limit(1);
    return rows[0];
  }

  /**
   * Set the organization's access-policy document, upserting on `organization_id`: a first write
   * inserts, a re-set overwrites the document (and who set it, and when) in place. `id` and
   * `organization_id` are never changed on the update path — the 0072 trigger holds them immutable
   * besides.
   */
  async upsert(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: { readonly policy: OrgPolicyValue; readonly updatedBy: string },
  ): Promise<void> {
    await tenantDrizzle(runner)
      .insert(orgPolicies)
      .values({
        id: uuidv7(),
        organizationId: context.organizationId,
        policyJson: input.policy,
        updatedBy: input.updatedBy,
        createdAt: sql`current_timestamp(3)`,
        updatedAt: sql`current_timestamp(3)`,
      })
      .onDuplicateKeyUpdate({
        set: {
          policyJson: input.policy,
          updatedBy: input.updatedBy,
          updatedAt: sql`current_timestamp(3)`,
        },
      });
  }
}

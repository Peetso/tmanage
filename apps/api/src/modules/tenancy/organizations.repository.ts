import { eq, isNull, sql, and } from 'drizzle-orm';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { organizations } from '../../common/database/schema.js';
import type { OrganizationRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * The organization aggregate — TEN-001.
 *
 * Shorter than the other repositories in this module for a structural reason rather than an
 * incidental one: **a context is bound to exactly one organization**, so there is no `list`,
 * no `findById(id)`, and no way to name an organization other than the acting one. The
 * signature is not "which organization?" but "the one you are already in".
 *
 * `organizations` is the one tenant-owned table whose tenant key is `id` rather than
 * `organization_id` (see the guard's registry). That makes an unscoped read of it especially
 * dangerous — a forgotten predicate here lists the customer base — so every statement below
 * anchors on `organizations.id = context.organizationId`.
 *
 * ## Two operations are deliberately absent
 *
 * **Creation.** Provisioning an organization happens before any membership exists, so it
 * cannot run under a `TenantContext` and cannot be a method here. It belongs with signup,
 * needs ID-001's verified session and a founding-owner membership in the same transaction,
 * and is not written.
 *
 * **Slug changes.** The slug is in every URL a customer has bookmarked and in every link
 * already sent to their clients. Changing it needs a redirect story and a decision about
 * whether the old slug is reserved or reusable — a product question the planning pack does
 * not answer. Guessing at it here would ship the guess.
 */

export class OrganizationNotFoundError extends Error {
  constructor(readonly organizationId: string) {
    super('The acting organization was not found');
    this.name = 'OrganizationNotFoundError';
  }
}

export class OrganizationVersionConflictError extends Error {
  constructor(readonly organizationId: string) {
    super('The organization was modified concurrently');
    this.name = 'OrganizationVersionConflictError';
  }
}

export interface UpdateOrganizationInput {
  readonly name?: string;
  readonly defaultLocale?: string;
  readonly timezone?: string;
}

export class OrganizationsRepository {
  /** The acting organization, or null if it has since been deleted underneath the session. */
  async findCurrent(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<OrganizationRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(organizations)
      .where(eq(organizations.id, context.organizationId))
      .limit(1);
    return rows[0] ?? null;
  }

  async requireCurrent(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<OrganizationRow> {
    const found = await this.findCurrent(runner, context);
    if (!found) throw new OrganizationNotFoundError(context.organizationId);
    return found;
  }

  /**
   * Update the acting organization's settings, refusing a stale write.
   *
   * `updated_at` is the concurrency token: `organizations` has no `version` column in
   * `0001_tenancy.sql`. The alternative — adding one — is a migration, and inventing a
   * column here to make the repository tidier is how the schema and its description drift.
   */
  async update(
    runner: TenantQueryRunner,
    context: TenantContext,
    expectedUpdatedAt: Date,
    input: UpdateOrganizationInput,
  ): Promise<OrganizationRow> {
    const changes: Record<string, unknown> = { updatedAt: sql`current_timestamp(3)` };
    if (input.name !== undefined) changes['name'] = input.name;
    if (input.defaultLocale !== undefined) changes['defaultLocale'] = input.defaultLocale;
    if (input.timezone !== undefined) changes['timezone'] = input.timezone;

    const result = await tenantDrizzle(runner)
      .update(organizations)
      .set(changes)
      .where(
        and(
          eq(organizations.id, context.organizationId),
          eq(organizations.updatedAt, expectedUpdatedAt),
        ),
      );

    if (result[0].affectedRows === 0) {
      // No wrong-tenant case to distinguish here: the predicate names the acting
      // organization, so zero rows means either it is gone or the token is stale.
      const current = await this.findCurrent(runner, context);
      if (!current) throw new OrganizationNotFoundError(context.organizationId);
      throw new OrganizationVersionConflictError(context.organizationId);
    }

    return this.requireCurrent(runner, context);
  }

  /**
   * Archive the organization. There is no hard delete.
   *
   * This is the switch that ends access for everyone in the tenant at once: the membership
   * resolver refuses to resolve into an archived organization, so no new `TenantContext` can
   * be built for it and every subsequent request fails at step 2 of the policy sequence. It
   * does not revoke contexts already built — those expire with their sessions, which is why
   * offboarding a *person* is a membership operation and not this one.
   */
  async archive(runner: TenantQueryRunner, context: TenantContext): Promise<OrganizationRow> {
    const result = await tenantDrizzle(runner)
      .update(organizations)
      .set({ archivedAt: sql`current_timestamp(3)`, updatedAt: sql`current_timestamp(3)` })
      .where(and(eq(organizations.id, context.organizationId), isNull(organizations.archivedAt)));

    if (result[0].affectedRows === 0) {
      const current = await this.findCurrent(runner, context);
      if (!current) throw new OrganizationNotFoundError(context.organizationId);
      return current; // Already archived; archiving twice is not an error.
    }

    return this.requireCurrent(runner, context);
  }
}

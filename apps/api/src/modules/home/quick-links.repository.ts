import { and, asc, eq, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { homeQuickLinks } from '../../common/database/schema.js';
import type { HomeQuickLinkRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * Home quick links store — a membership's own My Day shortcuts, read/added/reordered/removed and
 * nothing else (module 4 Home / My Day, x273).
 *
 * Every method names a membership. There is no `list(context)` that returns a studio's links: a
 * quick link is one member's, and a method without a `membershipId` parameter would be the one place
 * that rule could be dropped — the shape `home_pinned_items` and `home_widget_prefs` take for their
 * per-membership reads. The read and every write carry `organization_id = context.organizationId`,
 * so the tenant boundary is in the SQL, not in the caller.
 *
 * Validation of the label and path is the service's; this store persists what it is given whole. The
 * `id`, tenant and timestamps come from here, never from input.
 */
export class HomeQuickLinksRepository {
  /** Every quick link the acting membership holds in this tenant, in position order, id breaking ties. */
  async listForMembership(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
  ): Promise<readonly HomeQuickLinkRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(homeQuickLinks)
      .where(
        and(
          eq(homeQuickLinks.organizationId, context.organizationId),
          eq(homeQuickLinks.membershipId, membershipId),
        ),
      )
      .orderBy(asc(homeQuickLinks.position), asc(homeQuickLinks.id));
  }

  /** How many links the acting membership already has — the cap probe. */
  async countForMembership(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
  ): Promise<number> {
    const rows = await tenantDrizzle(runner)
      .select({ count: sql<number>`count(*)` })
      .from(homeQuickLinks)
      .where(
        and(
          eq(homeQuickLinks.organizationId, context.organizationId),
          eq(homeQuickLinks.membershipId, membershipId),
        ),
      );
    return Number(rows[0]?.count ?? 0);
  }

  /** Insert one quick link for the acting membership at the given position. Tenant and id are set here. */
  async insert(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: {
      readonly membershipId: string;
      readonly label: string;
      readonly path: string;
      readonly position: number;
    },
  ): Promise<void> {
    await tenantDrizzle(runner)
      .insert(homeQuickLinks)
      .values({
        id: uuidv7(),
        organizationId: context.organizationId,
        membershipId: input.membershipId,
        label: input.label,
        path: input.path,
        position: input.position,
        createdAt: sql`current_timestamp(3)`,
        updatedAt: sql`current_timestamp(3)`,
      });
  }

  /**
   * Set one link's position, scoped by `membership_id = the acting membership`, so a reorder can
   * only touch the caller's own links. The trigger holds `organization_id`/`membership_id` immutable.
   */
  async updatePosition(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
    id: string,
    position: number,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .update(homeQuickLinks)
      .set({ position })
      .where(
        and(
          eq(homeQuickLinks.organizationId, context.organizationId),
          eq(homeQuickLinks.membershipId, membershipId),
          eq(homeQuickLinks.id, id),
        ),
      );
  }

  /**
   * Delete the caller's own link by id. Scoped by `membership_id = the acting membership`, so an id
   * that names another member's link (or no link) removes nothing and the service answers 404 — a
   * quick link is private, so its existence is never disclosed to a member it does not belong to.
   */
  async deleteOwn(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
    id: string,
  ): Promise<boolean> {
    const result = await tenantDrizzle(runner)
      .delete(homeQuickLinks)
      .where(
        and(
          eq(homeQuickLinks.organizationId, context.organizationId),
          eq(homeQuickLinks.membershipId, membershipId),
          eq(homeQuickLinks.id, id),
        ),
      );
    return result[0].affectedRows > 0;
  }
}

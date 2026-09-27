import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { RECENT_ITEMS_CAP, homeRecentItems } from '../../common/database/schema.js';
import type { HomeRecentItemRow, RecentItemObjectType } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * HOME recents (x324) data half — a membership's recently-viewed references, and the idempotent
 * record-a-view upsert.
 *
 * ## The scope is the tenant boundary
 *
 * `object_id` carries no foreign key (the target table depends on `object_type`), so a recent's
 * tenant safety is not an FK. It is that every read and the upsert run an `organization_id =
 * context.organizationId` predicate, and the reference is stored verbatim with no title resolved —
 * so a recent can never disclose an entity, or a reference owned, in another studio.
 *
 * ## Recents are private to a membership, and the read is bounded
 *
 * Every read and the upsert are scoped by `membership_id = context.membershipId`, so one member
 * never sees or refreshes another's recents even inside the same tenant. The list is `LIMIT`ed to
 * {@link RECENT_ITEMS_CAP}, so a member's recents can never be an unbounded scan.
 */
export class RecentItemsRepository {
  /**
   * Record a view: insert the reference or, if the member has viewed this object before, refresh its
   * `viewed_at` in place (`ON DUPLICATE KEY UPDATE` against the unique key). Idempotent — a repeat
   * view moves the time, never a second row. The id, tenant and time come from here, never input.
   */
  async recordView(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: {
      readonly membershipId: string;
      readonly objectType: RecentItemObjectType;
      readonly objectId: string;
      readonly viewedAt: Date;
    },
  ): Promise<void> {
    await tenantDrizzle(runner)
      .insert(homeRecentItems)
      .values({
        id: uuidv7(),
        organizationId: context.organizationId,
        membershipId: input.membershipId,
        objectType: input.objectType,
        objectId: input.objectId,
        viewedAt: input.viewedAt,
        createdAt: sql`current_timestamp(3)`,
      })
      .onDuplicateKeyUpdate({ set: { viewedAt: input.viewedAt } });
  }

  /**
   * The acting membership's recents in this tenant, newest first with id breaking ties for a total,
   * deterministic order, bounded to {@link RECENT_ITEMS_CAP} (the
   * `ix_home_recent_items_org_membership` index's order).
   */
  async listForMembership(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
  ): Promise<readonly HomeRecentItemRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(homeRecentItems)
      .where(
        and(
          eq(homeRecentItems.organizationId, context.organizationId),
          eq(homeRecentItems.membershipId, membershipId),
        ),
      )
      .orderBy(desc(homeRecentItems.viewedAt), asc(homeRecentItems.id))
      .limit(RECENT_ITEMS_CAP);
  }
}

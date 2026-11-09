import { and, asc, desc, eq, exists, or, sql, type SQL } from 'drizzle-orm';
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
/**
 * FIX5 item 6d (B11): a recent whose target still exists in this tenant and is not deleted. The
 * reference has no foreign key, so a soft-deleted work item, doc or meeting (`deleted_at` set) kept
 * showing as "Recently viewed work item" / "Recently viewed document" with nothing to open. Each
 * arm is a correlated `exists` on the target's own table, named by alias and pinned to the acting
 * organization, so the static tenant guard binds every subquery and no row of another tenant can
 * ever keep a recent alive. Archived docs and projects still open from a link, so they stay.
 */
export function liveRecentTarget(organizationId: string): SQL {
  const r = homeRecentItems;
  return or(
    and(
      eq(r.objectType, 'work'),
      exists(
        sql`(select 1 from work_items rv_wi where rv_wi.organization_id = ${organizationId} and rv_wi.id = ${r.objectId} and rv_wi.deleted_at is null)`,
      ),
    ),
    and(
      eq(r.objectType, 'document'),
      exists(
        sql`(select 1 from documents rv_doc where rv_doc.organization_id = ${organizationId} and rv_doc.id = ${r.objectId} and rv_doc.deleted_at is null)`,
      ),
    ),
    and(
      eq(r.objectType, 'project'),
      exists(
        sql`(select 1 from projects rv_prj where rv_prj.organization_id = ${organizationId} and rv_prj.id = ${r.objectId})`,
      ),
    ),
    and(
      eq(r.objectType, 'meeting'),
      exists(
        sql`(select 1 from meetings rv_mtg where rv_mtg.organization_id = ${organizationId} and rv_mtg.id = ${r.objectId} and rv_mtg.deleted_at is null)`,
      ),
    ),
  ) as SQL;
}

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
   * `ix_home_recent_items_org_membership` index's order). FIX5 item 6d: only recents whose target
   * still exists and is not deleted ({@link liveRecentTarget}), so the cap counts live rows.
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
          liveRecentTarget(context.organizationId),
        ),
      )
      .orderBy(desc(homeRecentItems.viewedAt), asc(homeRecentItems.id))
      .limit(RECENT_ITEMS_CAP);
  }
}

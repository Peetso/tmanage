import { and, eq, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { homeWidgetPrefs } from '../../common/database/schema.js';
import type { HomeWidgetPrefRow, HomeWidgetPrefs } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * Home widget preferences store — read one member's Home widget layout, write it, and nothing else
 * (module 4 Home / My Day, x243).
 *
 * Both methods name a membership. There is no `list(context)` that returns a studio's layouts: a
 * layout is one member's, and a method without a `membershipId` parameter would be the one place
 * that rule could be dropped — the same shape `home_pinned_items` and `a11y_preferences` take for
 * their per-membership reads.
 *
 * ## The write is one upsert, not a read-then-write
 *
 * {@link upsert} is a single `INSERT ... ON DUPLICATE KEY UPDATE` against
 * `uq_home_widget_prefs_org_membership`. Two saves racing for one member's row serialise on the
 * unique key rather than on a row this code read first, so a lost update is not expressible. The
 * insert path fills `id`; the update path leaves it alone and moves only the two lists, and
 * `updated_at` follows by the column's `ON UPDATE`. Validation of the widget ids is the controller's;
 * this store persists what it is given whole.
 */
export class HomeWidgetPrefsRepository {
  async findForMembership(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
  ): Promise<HomeWidgetPrefRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(homeWidgetPrefs)
      .where(
        and(
          eq(homeWidgetPrefs.organizationId, context.organizationId),
          eq(homeWidgetPrefs.membershipId, membershipId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** Create or replace this member's Home widget layout in this studio. Idempotent by the unique key. */
  async upsert(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
    prefs: HomeWidgetPrefs,
  ): Promise<void> {
    const order = [...prefs.order];
    const hidden = [...prefs.hidden];
    await tenantDrizzle(runner)
      .insert(homeWidgetPrefs)
      .values({
        id: uuidv7(),
        organizationId: context.organizationId,
        membershipId,
        widgetOrderJson: order,
        hiddenWidgetsJson: hidden,
        updatedAt: sql`current_timestamp(3)`,
      })
      .onDuplicateKeyUpdate({
        set: {
          widgetOrderJson: order,
          hiddenWidgetsJson: hidden,
        },
      });
  }
}

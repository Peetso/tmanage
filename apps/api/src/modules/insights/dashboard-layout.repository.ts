import { and, eq, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { insightDashboardLayouts } from '../../common/database/schema.js';
import type {
  InsightDashboardLayoutRow,
  InsightDashboardTile,
} from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * Insight dashboard layout store — read one member's insights-dashboard tile layout, write it, and
 * nothing else (module 16 Insights, x302). Mirrors `home_widget_prefs`' repository (x243).
 *
 * Both methods name a membership. There is no `list(context)` that returns a studio's layouts: a
 * layout is one member's, and a method without a `membershipId` parameter would be the one place
 * that rule could be dropped — the same shape `home_widget_prefs` and `a11y_preferences` take for
 * their per-membership reads.
 *
 * ## The write is one upsert, not a read-then-write
 *
 * {@link upsert} is a single `INSERT ... ON DUPLICATE KEY UPDATE` against
 * `uq_insight_dashboard_layouts_org_membership`. Two saves racing for one member's row serialise on
 * the unique key rather than on a row this code read first, so a lost update is not expressible. The
 * insert path fills `id`; the update path leaves it alone and moves only the tiles list, and
 * `updated_at` follows by the column's `ON UPDATE`. Validation of the tile keys is the controller's;
 * this store persists what it is given whole.
 */
export class InsightDashboardLayoutRepository {
  async findForMembership(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
  ): Promise<InsightDashboardLayoutRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(insightDashboardLayouts)
      .where(
        and(
          eq(insightDashboardLayouts.organizationId, context.organizationId),
          eq(insightDashboardLayouts.membershipId, membershipId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** Create or replace this member's insight-dashboard layout. Idempotent by the unique key. */
  async upsert(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
    tiles: readonly InsightDashboardTile[],
  ): Promise<void> {
    const stored = tiles.map((tile) => ({ ...tile }));
    await tenantDrizzle(runner)
      .insert(insightDashboardLayouts)
      .values({
        id: uuidv7(),
        organizationId: context.organizationId,
        membershipId,
        tilesJson: stored,
        updatedAt: sql`current_timestamp(3)`,
      })
      .onDuplicateKeyUpdate({
        set: {
          tilesJson: stored,
        },
      });
  }
}

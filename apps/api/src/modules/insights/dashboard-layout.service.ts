import { INSIGHT_METRIC_KEYS } from '../../common/database/schema.js';
import type { InsightDashboardTile } from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { InsightDashboardLayoutRepository } from './dashboard-layout.repository.js';

/**
 * Per-user insight dashboard layout service (module 16 Insights, x302).
 *
 * The DB orchestration behind the caller's-own GET/PUT: read the member's stored tiles (or the
 * shipped default when none), and upsert a validated layout inside a transaction, reading it back.
 * Tile-key validation is the controller's — a malformed body is the client's error to be told about
 * (400), not a state this service or the store should ever hold — so this service is handed an
 * already-validated tile list and persists it whole, the division `home_widget_prefs` takes.
 */
export class InsightDashboardLayoutService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly layouts: InsightDashboardLayoutRepository,
  ) {}

  /**
   * The caller's own saved layout, or the shipped default when they have never saved. The subject is
   * always the passed `membershipId` (the authenticated principal's), never a request value, so no
   * caller can read another member's layout.
   */
  async getForMembership(
    context: TenantContext,
    membershipId: string,
  ): Promise<readonly InsightDashboardTile[]> {
    const row = await this.database.read(context, (runner) =>
      this.layouts.findForMembership(runner, context, membershipId),
    );
    return row ? row.tilesJson : DEFAULT_INSIGHT_DASHBOARD_TILES;
  }

  /**
   * Replace the caller's own layout with an already-validated tile list and read it back. The upsert
   * and the read-back share one transaction and are both scoped to `membershipId`, so a caller only
   * ever writes and reads their own row.
   */
  async saveForMembership(
    context: TenantContext,
    membershipId: string,
    tiles: readonly InsightDashboardTile[],
  ): Promise<readonly InsightDashboardTile[]> {
    return this.database.transaction(context, async (tx) => {
      await this.layouts.upsert(tx, context, membershipId, tiles);
      const row = await this.layouts.findForMembership(tx, context, membershipId);
      return row ? row.tilesJson : tiles;
    });
  }
}

/**
 * The shipped default an unsaved member is reached by: every known metric tile shown, in the
 * declared {@link INSIGHT_METRIC_KEYS} order, each visible.
 */
export const DEFAULT_INSIGHT_DASHBOARD_TILES: readonly InsightDashboardTile[] =
  INSIGHT_METRIC_KEYS.map((key, index) => ({ key, position: index, visible: true }));

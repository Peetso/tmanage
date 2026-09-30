import type { InsightFavoriteMetricKey } from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { InsightMetricFavoritesRepository } from './metric-favorites.repository.js';

/**
 * INS metric favorites (x303) — a member stars a known insight metric, unstars it, and lists their own
 * starred metrics. A per-membership surface kept in its own table `insight_metric_favorites`,
 * registered on the Insights module.
 *
 * ## Authorization
 *
 * Every route is gated on `work.read` at the controller (the internal-read capability the sibling
 * insights reads reuse; `12-PERMISSION-MATRIX` names no per-user-preference capability and pass-25
 * forbids editing `capabilities.ts`). There is no object to relation-check: a `metricKey` is a code
 * constant, not a tenant row. The fine control is membership scope — every write and the list are
 * scoped to `context.membershipId`, so a member can never create, remove, or read another member's
 * favorites even inside the same tenant. The `metricKey` allowlist is enforced at the controller
 * (a key off the fixed set is a 400, nothing written); this service trusts the typed key.
 */

/**
 * One of the caller's starred insight metrics — paired Exact with the web's `MetricFavoriteSummary` in
 * the contracts gate. `organizationId`/`membershipId` are deliberately absent — the wire projection
 * never echoes the tenant id (`25-AUTH` §7), and the membership is always the caller's own.
 */
export interface MetricFavoriteView {
  readonly id: string;
  readonly metricKey: InsightFavoriteMetricKey;
  /** ISO-8601 instant. */
  readonly createdAt: string;
}

export class InsightMetricFavoritesService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly favorites: InsightMetricFavoritesRepository = new InsightMetricFavoritesRepository(),
  ) {}

  /**
   * Star a metric for the caller, idempotently. A repeated PUT returns the same view, never a second
   * row. `metricKey` is already validated against the allowlist by the controller.
   */
  async add(
    context: TenantContext,
    metricKey: InsightFavoriteMetricKey,
  ): Promise<MetricFavoriteView> {
    const row = await this.database.transaction(context, (tx) =>
      this.favorites.add(tx, context, { membershipId: context.membershipId, metricKey }),
    );
    return { id: row.id, metricKey: row.metricKey, createdAt: row.createdAt.toISOString() };
  }

  /** Remove the caller's favorite of a metric, idempotently (no favorite → still success). */
  async remove(context: TenantContext, metricKey: InsightFavoriteMetricKey): Promise<void> {
    await this.database.transaction(context, (tx) =>
      this.favorites.remove(tx, context, context.membershipId, metricKey),
    );
  }

  /** List the caller's starred metrics, newest first. */
  async list(context: TenantContext): Promise<readonly MetricFavoriteView[]> {
    const rows = await this.database.read(context, (runner) =>
      this.favorites.listForMember(runner, context, context.membershipId),
    );
    return rows.map((row) => ({
      id: row.id,
      metricKey: row.metricKey,
      createdAt: row.createdAt.toISOString(),
    }));
  }
}

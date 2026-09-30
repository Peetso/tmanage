import { Controller, Delete, Get, HttpCode, Inject, Param, Put } from '@nestjs/common';
import { Ctx, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { INSIGHT_METRIC_KEYS } from '../../common/database/schema.js';
import type { InsightMetricKey } from '../../common/database/schema.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { InsightMetricFavoritesService } from './metric-favorites.service.js';
import type { MetricFavoriteView } from './metric-favorites.service.js';

/**
 * INS metric favorites (x303). Star an insight metric, unstar it, and list the caller's starred
 * metrics. Like every tenant-scoped controller here it never reads `organizationId` (or the acting
 * membership) from the body, a header, or its `:orgSlug` segment: it receives the `TenantContext`
 * that `TenantContextGuard` built from a membership row and passes it on. Every route is `work.read`
 * — the internal-read capability the sibling insights reads reuse; the fine control is membership
 * scope, applied in the service.
 *
 * The per-metric toggle lives under `insights/metric-favorites/:metricKey`; the caller's list lives at
 * the bare `insights/metric-favorites`. Validation of `metricKey` against the fixed
 * {@link INSIGHT_METRIC_KEYS} allowlist is here — a key off the set is a 400 and nothing is written,
 * the `home_widget_prefs` posture — so the store never holds a key the app cannot render.
 */
export const INSIGHT_METRIC_FAVORITES_SERVICE = Symbol.for('tmanage.InsightMetricFavoritesService');

@Controller('v1/organizations/:orgSlug/insights/metric-favorites')
export class InsightMetricFavoritesController {
  constructor(
    @Inject(INSIGHT_METRIC_FAVORITES_SERVICE)
    private readonly favorites: InsightMetricFavoritesService,
  ) {}

  /** List the caller's starred metrics, newest first. */
  @Get()
  @RequireCapability('work.read')
  async list(
    @Ctx() context: TenantContext,
  ): Promise<{ readonly favorites: readonly MetricFavoriteView[] }> {
    return { favorites: await this.favorites.list(context) };
  }

  /** Star a metric for the caller. Idempotent: a repeated PUT returns the same view (200). */
  @Put(':metricKey')
  @RequireCapability('work.read')
  async add(
    @Ctx() context: TenantContext,
    @Param('metricKey') metricKey: string,
  ): Promise<MetricFavoriteView> {
    return this.favorites.add(context, requireKnownMetricKey(metricKey));
  }

  /** Unstar a metric for the caller. Idempotent: no favorite is still 204. */
  @Delete(':metricKey')
  @RequireCapability('work.read')
  @HttpCode(204)
  async remove(
    @Ctx() context: TenantContext,
    @Param('metricKey') metricKey: string,
  ): Promise<void> {
    await this.favorites.remove(context, requireKnownMetricKey(metricKey));
  }
}

/**
 * A path `metricKey` is always required and must be one of the fixed known-metric ids. An unknown key
 * is a 400 (nothing written), never a stored row the app cannot render.
 */
function requireKnownMetricKey(metricKey: unknown): InsightMetricKey {
  if (
    typeof metricKey === 'string' &&
    (INSIGHT_METRIC_KEYS as readonly string[]).includes(metricKey)
  ) {
    return metricKey as InsightMetricKey;
  }
  throw new ApiError(400, 'validation_failed', 'metricKey is not a known insight metric', [
    { field: 'metricKey', message: 'must be one of the known insight metric keys' },
  ]);
}

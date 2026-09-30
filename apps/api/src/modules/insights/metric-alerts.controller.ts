import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Module,
  Param,
  Put,
} from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import {
  InsightMetricAlertsService,
  insightMetricAlertsForbidden,
  parseComparator,
  parseMetricKey,
  parseThreshold,
} from './metric-alerts.service.js';
import type { MetricAlertStatusView, MetricAlertView } from './metric-alerts.service.js';

/** DI token for the metric-alerts service, owned by this slice (registered in `app.module.ts`). */
export const INSIGHT_METRIC_ALERTS_SERVICE = Symbol.for('tmanage.InsightMetricAlertsService');

/**
 * x319's HTTP surface — Insight metric alerts (module 15, Insights & reporting).
 *
 * A separate controller and module from the other insights slices, disjoint by file so the insights
 * work lands in parallel without a shared append point. Three routes under
 * `/v1/organizations/:orgSlug/insights/metric-alerts`, all self-scoped to the caller:
 *
 * - **PUT** sets (creates or replaces) the caller's alert for one metric — idempotent by the
 *   `(org, member, metric)` unique key.
 * - **GET** lists the caller's alerts, each marked breached/ok against the latest workload snapshot.
 * - **DELETE `/:metricKey`** removes the caller's alert for one metric (204, idempotent).
 *
 * Every route is `work.read` — the internal-read capability the sibling insights reads reuse (the
 * permission matrix names no personal-alert capability and the pass forbids inventing one); each
 * handler re-checks it org-level (`projectId: null`) as the tenant-checked decision, the
 * belt-and-braces the sibling insights controllers apply. The subject is always the authenticated
 * principal — the request has no way to name another member. Validation lives here: an unknown metric
 * key or comparator, or a non-numeric/out-of-range threshold, is a 400 with no write. The tenant is
 * the slug resolved against the caller's membership before the handler — a cross-tenant caller is a
 * 404 there, never a cross-tenant write or read.
 */
@Controller('v1/organizations/:orgSlug/insights/metric-alerts')
export class InsightMetricAlertsController {
  constructor(
    @Inject(INSIGHT_METRIC_ALERTS_SERVICE) private readonly alerts: InsightMetricAlertsService,
  ) {}

  /** List the caller's alerts, each evaluated breached/ok against the latest workload snapshot. */
  @Get()
  @RequireCapability('work.read')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<{ readonly alerts: readonly MetricAlertStatusView[] }> {
    if (!this.alerts.mayReadOrgInsights(principal, context)) throw insightMetricAlertsForbidden();
    return { alerts: await this.alerts.list(context, principal) };
  }

  /** Set (create or replace) the caller's alert for one metric. Unknown metric/comparator or bad threshold → 400. */
  @Put()
  @RequireCapability('work.read')
  async set(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: { metricKey?: unknown; comparator?: unknown; threshold?: unknown } | undefined,
  ): Promise<MetricAlertView> {
    if (!this.alerts.mayReadOrgInsights(principal, context)) throw insightMetricAlertsForbidden();
    const input: MetricAlertView = {
      metricKey: parseMetricKey(body?.metricKey),
      comparator: parseComparator(body?.comparator),
      threshold: parseThreshold(body?.threshold),
    };
    return this.alerts.set(context, principal, input);
  }

  /** Delete the caller's alert for one metric. Unknown metric key → 400; success is a 204 (idempotent). */
  @Delete(':metricKey')
  @RequireCapability('work.read')
  @HttpCode(204)
  async remove(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('metricKey') metricKey: string,
  ): Promise<void> {
    if (!this.alerts.mayReadOrgInsights(principal, context)) throw insightMetricAlertsForbidden();
    if (typeof metricKey !== 'string' || metricKey === '') {
      throw new ApiError(400, 'validation_failed', 'metricKey is required', [
        { field: 'metricKey', message: 'must be a non-empty string' },
      ]);
    }
    await this.alerts.remove(context, principal, parseMetricKey(metricKey));
  }
}

/**
 * x319's wiring — a self-contained module registered from `app.module.ts`, so the insights slices stay
 * file-disjoint. The service needs only the `@Global` `TENANT_DATABASE` for its tenant-scoped upsert,
 * reads (including the read-only latest-workload-snapshot join the evaluation uses) and delete.
 */
@Module({})
export class InsightMetricAlertsModule {
  static register(): DynamicModule {
    const service: Provider = {
      provide: INSIGHT_METRIC_ALERTS_SERVICE,
      inject: [TENANT_DATABASE],
      useFactory: (database: TenantDatabase) => new InsightMetricAlertsService(database),
    };

    return {
      module: InsightMetricAlertsModule,
      providers: [service],
      controllers: [InsightMetricAlertsController],
    };
  }
}

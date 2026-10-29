import { Controller, Get, Inject, Module, Query } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import {
  InsightComparisonService,
  parseComparisonMetric,
  parseWindow,
} from './comparison.service.js';
import type { PeriodComparisonView } from './comparison.service.js';

/**
 * x229's HTTP surface — Insight period-over-period comparison (module 15, Insights & reporting).
 *
 * A separate controller and module from x89/x123's `InsightsController`, disjoint by file so the
 * insights slices land in parallel without a shared append point (the posture the sibling
 * `InsightsAdoptionController` and `InsightSnapshotsController` document). It exposes one route,
 * `GET /v1/organizations/:orgSlug/insights/compare`, behind `work.read` — the internal-read
 * capability the delivery-flow, workload, adoption and snapshot reads already reuse, so this slice
 * needs no new capability and no `capabilities.ts` / role-grid edit.
 *
 * ## Org-level, and gated as one
 *
 * A comparison is an org-level aggregate, so — like the sibling reads — it is authorized once at org
 * level (a `work.read` `authorize()` with `projectId: null`); a principal the check refuses gets a
 * 403 rather than a silently empty result. `work.read` is internal-only, so a client principal is
 * refused here exactly as the route's `CapabilityGuard` refuses one — the relation half of the same
 * capability, belt-and-braces to the guard.
 *
 * ## Validate everything before computing
 *
 * The metric is resolved against a fixed allowlist (unknown → 400) and both windows are parsed and
 * validated (malformed or inverted → 400) **before** either count runs, so a bad request is never a
 * partial compute. The windows are bound `Date` values, not the DB clock.
 */
@Controller('v1/organizations/:orgSlug/insights')
export class InsightComparisonController {
  // An explicit token: `emitDecoratorMetadata` is off (ADR-0003), so an un-annotated class
  // parameter would be injected as `undefined` and every read would 500.
  constructor(
    @Inject(InsightComparisonService) private readonly comparison: InsightComparisonService,
  ) {}

  /**
   * Compare one metric across two windows. Tenant-scoped by `orgSlug`; authorized once at org level
   * (a `work.read` refusal is a 403, not an empty result); the metric is resolved against the fixed
   * allowlist (unknown → 400) and both windows validated (malformed/inverted → 400) before any count
   * runs. A pure read — no write, no stored row.
   */
  @Get('compare')
  @RequireCapability('report.view')
  async compare(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Query('metric') metric?: string,
    @Query('periodA') periodA?: string,
    @Query('periodB') periodB?: string,
  ): Promise<PeriodComparisonView> {
    // Org-level relation check: the route's role ceiling mirrored as the belt-and-braces the sibling
    // reads apply. `work.read` is internal-only, so a client is refused here — a 403, not a silently
    // empty comparison over an org-level internal read. Checked before any parse touches input.
    if (!this.comparison.mayReadOrgInsights(principal, context)) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, 'insight_compare_denied');
    }

    const resolvedMetric = parseComparisonMetric(metric);
    const windowA = parseWindow(periodA, 'periodA');
    const windowB = parseWindow(periodB, 'periodB');

    return this.comparison.compare(context, resolvedMetric, windowA, windowB);
  }
}

/**
 * x229's wiring — a self-contained module registered from `app.module.ts` (the shared append point)
 * rather than folded into x89/x123's `InsightsModule`, so the insights slices stay file-disjoint.
 * The service is provided by its class (no new token in `tokens.ts`), constructed from the `@Global`
 * `TENANT_DATABASE` for its tenant-scoped counts.
 */
@Module({})
export class InsightComparisonModule {
  static register(): DynamicModule {
    const service: Provider = {
      provide: InsightComparisonService,
      inject: [TENANT_DATABASE],
      useFactory: (database: TenantDatabase) => new InsightComparisonService(database),
    };

    return {
      module: InsightComparisonModule,
      providers: [service],
      controllers: [InsightComparisonController],
    };
  }
}

import { Body, Controller, Get, Inject, Module, Put } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { INSIGHT_TARGETS_SERVICE, TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { WorkItemsRepository } from '../work/work-items.repository.js';
import { WorkloadRepository } from '../work-views/workload.repository.js';
import { ProjectsRepository } from '../projects/projects.repository.js';
import { DeliveryFlowRepository } from './delivery-flow.repository.js';
import { ApprovalCycleRepository, InsightsApprovalsReader } from './approval-cycle.repository.js';
import { InsightsService } from './insights.service.js';
import {
  InsightTargetsService,
  insightTargetsForbidden,
  parseMetric,
  parsePeriod,
  parseTargetValue,
} from './targets.service.js';
import type { MetricTargetStatusView, MetricTargetView } from './targets.service.js';

/**
 * x230's HTTP surface — Insight metric targets (module 15, Insights & reporting).
 *
 * A separate controller and module from the other insights slices, disjoint by file so the insights
 * work lands in parallel without a shared append point. Three routes under
 * `/v1/organizations/:orgSlug/insights/targets`:
 *
 * - **PUT** sets an org's target for one metric — org configuration, so behind `org.manage` (a viewer
 *   with `work.read` alone sees targets but is refused a 403 here). Idempotent: setting a metric's
 *   target again replaces it.
 * - **GET** lists the org's targets — behind `work.read`, the internal-read capability the sibling
 *   insights reads reuse, so this slice needs no new capability and no `capabilities.ts` edit.
 * - **GET `/status`** compares each live metric to its target (on-track / behind) — a read/compute over
 *   `work.read`, guarding a zero target so no divide error.
 *
 * Each handler re-checks the capability org-level (`projectId: null`), the belt-and-braces the sibling
 * insights controllers apply to the route guard. An unknown metric or period, or an out-of-range
 * target, is a 400 with no write. The tenant is the slug resolved against the caller's membership
 * before the handler — a cross-tenant caller is a 404 there, never a cross-tenant write or read.
 */
@Controller('v1/organizations/:orgSlug/insights/targets')
export class InsightTargetsController {
  constructor(@Inject(INSIGHT_TARGETS_SERVICE) private readonly targets: InsightTargetsService) {}

  /** Set an org's target for one metric. Org-level `org.manage` (refusal is a 403); unknown metric/period or out-of-range value → 400. */
  @Put()
  @RequireCapability('org.manage')
  async set(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: { metric?: unknown; targetValue?: unknown; period?: unknown } | undefined,
  ): Promise<MetricTargetView> {
    if (!this.targets.mayManageOrgInsights(principal, context)) throw insightTargetsForbidden();
    const input: MetricTargetView = {
      metric: parseMetric(body?.metric),
      targetValue: parseTargetValue(body?.targetValue),
      period: parsePeriod(body?.period),
    };
    return this.targets.setTarget(context, input);
  }

  /** List the org's targets. Org-level `work.read` (refusal is a 403), tenant-scoped by `orgSlug`. */
  @Get()
  @RequireCapability('report.view')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<readonly MetricTargetView[]> {
    if (!this.targets.mayReadOrgInsights(principal, context)) throw insightTargetsForbidden();
    return this.targets.list(context);
  }

  /** Compare each stored target to its live metric value — on-track / behind. Org-level `work.read`. */
  @Get('status')
  @RequireCapability('report.view')
  async status(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<readonly MetricTargetStatusView[]> {
    if (!this.targets.mayReadOrgInsights(principal, context)) throw insightTargetsForbidden();
    return this.targets.status(context, principal);
  }
}

/**
 * x230's wiring — a self-contained module registered from `app.module.ts`, so the insights slices stay
 * file-disjoint. The service reuses `InsightsService` (constructed here from its stateless
 * repositories, the same construction the sibling insights modules use) to compute the live metrics
 * the status read judges, and the `@Global` `TENANT_DATABASE` for its tenant-scoped upsert and reads.
 */
@Module({})
export class InsightTargetsModule {
  static register(): DynamicModule {
    const service: Provider = {
      provide: INSIGHT_TARGETS_SERVICE,
      inject: [TENANT_DATABASE],
      useFactory: (database: TenantDatabase) =>
        new InsightTargetsService(
          database,
          new InsightsService(
            database,
            new DeliveryFlowRepository(new WorkItemsRepository()),
            new ApprovalCycleRepository(new InsightsApprovalsReader()),
            new WorkloadRepository(new WorkItemsRepository()),
            new ProjectsRepository(),
          ),
        ),
    };

    return {
      module: InsightTargetsModule,
      providers: [service],
      controllers: [InsightTargetsController],
    };
  }
}

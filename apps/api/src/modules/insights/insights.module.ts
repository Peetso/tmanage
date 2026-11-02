import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import { AUDIT_SERVICE, INSIGHTS_SERVICE, TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { WorkItemsRepository } from '../work/work-items.repository.js';
import { WorkloadRepository } from '../work-views/workload.repository.js';
import { ProjectsRepository } from '../projects/projects.repository.js';
import { DeliveryFlowRepository } from './delivery-flow.repository.js';
import { ApprovalCycleRepository, InsightsApprovalsReader } from './approval-cycle.repository.js';
import { InsightsService } from './insights.service.js';
import { InsightsController } from './insights.controller.js';
import { InsightsExportController } from './insights-export.controller.js';
import {
  INSIGHT_METRIC_FAVORITES_SERVICE,
  InsightMetricFavoritesController,
} from './metric-favorites.controller.js';
import { InsightMetricFavoritesService } from './metric-favorites.service.js';
import type { AuditService } from '../audit/audit.service.js';
import { BudgetBurnRepository } from '../projects/budget-burn.repository.js';
import { FINANCE_REPORTS_SERVICE, FinanceReportsController } from './finance-reports.controller.js';
import { FinanceReportsRepository } from './finance-reports.repository.js';
import { FinanceReportsService } from './finance-reports.service.js';

/**
 * INS-01's wiring — the insights module's first slice.
 *
 * `WorkItemsRepository` is constructed here rather than injected from `WorkModule`, the choice
 * `RequestsModule` documents: `WorkModule` is registered through `.register()`, so importing it
 * would build a second copy of the dynamic module rather than reuse the first. A repository is a
 * stateless collection of queries with no injected dependencies, so a second instance costs
 * nothing and reads honestly — this module owns its own read-only handle on `work_items` and
 * never edits the `work` module.
 */
@Module({})
export class InsightsModule {
  static register(): DynamicModule {
    const service: Provider = {
      provide: INSIGHTS_SERVICE,
      inject: [TENANT_DATABASE],
      useFactory: (database: TenantDatabase) =>
        new InsightsService(
          database,
          new DeliveryFlowRepository(new WorkItemsRepository()),
          new ApprovalCycleRepository(new InsightsApprovalsReader()),
          // INS-05 reuses x99's per-project workload read and enumerates projects tenant-scoped;
          // both are stateless query collections, constructed here like the readers above.
          new WorkloadRepository(new WorkItemsRepository()),
          new ProjectsRepository(),
        ),
    };

    // INS metric favorites (x303): a member's own starred insight metrics. Its own service and table
    // (`insight_metric_favorites`), constructed here like the readers above — a per-membership
    // surface that shares nothing with the roll-up reads but the module's tenant database handle.
    const metricFavorites: Provider = {
      provide: INSIGHT_METRIC_FAVORITES_SERVICE,
      inject: [TENANT_DATABASE],
      useFactory: (database: TenantDatabase) => new InsightMetricFavoritesService(database),
    };

    // 52-14 (R17-a) profitability / unbilled / utilisation reports and the facts rebuild. Reads the
    // 52-05 budget caches through a read-only `BudgetBurnRepository` handle (stateless, as above).
    const financeReports: Provider = {
      provide: FINANCE_REPORTS_SERVICE,
      inject: [TENANT_DATABASE, AUDIT_SERVICE],
      useFactory: (database: TenantDatabase, audit: AuditService) =>
        new FinanceReportsService({
          database,
          repository: new FinanceReportsRepository(),
          budgets: new BudgetBurnRepository(),
          audit,
        }),
    };

    return {
      module: InsightsModule,
      providers: [service, metricFavorites, financeReports],
      exports: [service],
      // INS-05 export shares the JSON reads' service and capability; a separate controller only
      // because its response mode (a CSV download) differs from the JSON reads'.
      controllers: [
        InsightsController,
        InsightsExportController,
        InsightMetricFavoritesController,
        FinanceReportsController,
      ],
    };
  }
}

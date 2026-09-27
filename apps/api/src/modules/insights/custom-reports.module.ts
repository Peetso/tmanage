import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import { INSIGHT_CUSTOM_REPORTS_SERVICE, TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { WorkItemsRepository } from '../work/work-items.repository.js';
import { WorkloadRepository } from '../work-views/workload.repository.js';
import { ProjectsRepository } from '../projects/projects.repository.js';
import { DeliveryFlowRepository } from './delivery-flow.repository.js';
import { ApprovalCycleRepository, InsightsApprovalsReader } from './approval-cycle.repository.js';
import { InsightsService } from './insights.service.js';
import { InsightCustomReportsController } from './custom-reports.controller.js';
import { InsightCustomReportsService } from './custom-reports.service.js';

/**
 * INS custom reports wiring (module 15, x320).
 *
 * A service and the caller's-own create/list/get/replace/delete routes over `TENANT_DATABASE`. Kept in
 * a module of its own — file-disjoint from the read-only `InsightsModule` and the sibling insights
 * write slices — so neither slice edits a file the other appends to. It reuses `InsightsService`
 * (constructed here the way `InsightTargetsModule` does — the readers are stateless query collections,
 * so a second instance costs nothing) to render a report's selected metrics live. Every provider
 * carries an explicit token (ADR-0003).
 */
@Module({})
export class InsightCustomReportsModule {
  static register(): DynamicModule {
    const service: Provider = {
      provide: INSIGHT_CUSTOM_REPORTS_SERVICE,
      inject: [TENANT_DATABASE],
      useFactory: (database: TenantDatabase) =>
        new InsightCustomReportsService(
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
      module: InsightCustomReportsModule,
      providers: [service],
      controllers: [InsightCustomReportsController],
    };
  }
}

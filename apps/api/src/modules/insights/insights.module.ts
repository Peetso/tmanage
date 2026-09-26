import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import { INSIGHTS_SERVICE, TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { WorkItemsRepository } from '../work/work-items.repository.js';
import { WorkloadRepository } from '../work-views/workload.repository.js';
import { ProjectsRepository } from '../projects/projects.repository.js';
import { DeliveryFlowRepository } from './delivery-flow.repository.js';
import { ApprovalCycleRepository, InsightsApprovalsReader } from './approval-cycle.repository.js';
import { InsightsService } from './insights.service.js';
import { InsightsController } from './insights.controller.js';

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

    return {
      module: InsightsModule,
      providers: [service],
      exports: [service],
      controllers: [InsightsController],
    };
  }
}

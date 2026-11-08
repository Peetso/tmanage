import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import { TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { WorkloadForecastRepository } from './workload-forecast.repository.js';
import { WorkloadForecastService } from './workload-forecast.service.js';
import { WorkloadForecastController } from './workload-forecast.controller.js';
import { WorkloadHoursRepository } from './workload-hours.repository.js';
import { WorkloadHoursService } from './workload-hours.service.js';
import { WorkloadHoursController } from './workload-hours.controller.js';

/**
 * x134's wiring — the Insights workload-forecast read.
 *
 * A module of its own rather than an addition to {@link InsightsModule}: the sibling insights slices
 * register their own modules in `app.module.ts` (the shared, integrator-reconciled append point), so
 * this stays file-disjoint from them. The service is provided by its concrete class (no shared token
 * in `tokens.ts` to edit in parallel), and it builds its own repository handle — the same
 * stateless-query-collection pattern {@link InsightsModule} documents, so it reads honestly and
 * costs nothing.
 */
@Module({})
export class WorkloadForecastModule {
  static register(): DynamicModule {
    const service: Provider = {
      provide: WorkloadForecastService,
      inject: [TENANT_DATABASE],
      useFactory: (database: TenantDatabase) =>
        new WorkloadForecastService(database, new WorkloadForecastRepository()),
    };
    // A14: workload in hours with owner/admin-editable capacity, on the same insights base path.
    const hoursService: Provider = {
      provide: WorkloadHoursService,
      inject: [TENANT_DATABASE],
      useFactory: (database: TenantDatabase) =>
        new WorkloadHoursService(database, new WorkloadHoursRepository()),
    };

    return {
      module: WorkloadForecastModule,
      providers: [service, hoursService],
      exports: [service],
      controllers: [WorkloadForecastController, WorkloadHoursController],
    };
  }
}

import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import { TENANT_DATABASE, WORK_VIEWS_SERVICE } from '../../common/http/tokens.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { ProjectsRepository } from '../projects/projects.repository.js';
import { WorkTimelineRepository } from './timeline.repository.js';
import { WorkloadRepository } from './workload.repository.js';
import { WorkCalendarRepository } from './calendar.repository.js';
import { SavedViewsRepository } from './saved-views.repository.js';
import { WorkViewsService } from './work-views.service.js';
import { WorkViewsController } from './work-views.controller.js';
import { PortalTimelineController, PortalTimelineService } from './portal-timeline.controller.js';

/**
 * WK-04's wiring — the Work views read layer.
 *
 * It depends on nothing but the database: the service composes the work + work-graph reads
 * through {@link WorkTimelineRepository}, which constructs its own (stateless) instances of the
 * borrowed repositories. It never provides or exports the work module's service, so it does not
 * couple to x88's in-flight edits to `work-items.service.ts`.
 */
@Module({})
export class WorkViewsModule {
  static register(): DynamicModule {
    const service: Provider = {
      provide: WORK_VIEWS_SERVICE,
      inject: [TENANT_DATABASE],
      useFactory: (database: TenantDatabase) =>
        new WorkViewsService(
          database,
          new WorkTimelineRepository(),
          new WorkloadRepository(),
          new WorkCalendarRepository(),
          new SavedViewsRepository(),
          new ProjectsRepository(),
        ),
    };

    // 53-07: the client timeline, read from the published copies only.
    const portalTimeline: Provider = {
      provide: PortalTimelineService,
      inject: [TENANT_DATABASE],
      useFactory: (database: TenantDatabase) => new PortalTimelineService(database),
    };

    return {
      module: WorkViewsModule,
      providers: [service, portalTimeline],
      exports: [service],
      controllers: [WorkViewsController, PortalTimelineController],
    };
  }
}

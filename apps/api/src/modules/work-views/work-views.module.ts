import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import { TENANT_DATABASE, WORK_VIEWS_SERVICE } from '../../common/http/tokens.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { WorkTimelineRepository } from './timeline.repository.js';
import { WorkViewsService } from './work-views.service.js';
import { WorkViewsController } from './work-views.controller.js';

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
        new WorkViewsService(database, new WorkTimelineRepository()),
    };

    return {
      module: WorkViewsModule,
      providers: [service],
      exports: [service],
      controllers: [WorkViewsController],
    };
  }
}

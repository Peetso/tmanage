import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import { TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { ActivityService, ACTIVITY_SERVICE } from './activity.service.js';
import { ClientActivityController, ProjectActivityController } from './activity.controller.js';

/**
 * 62-A2 (B02) — the Activity tab reads of a project and a client. Same shape as the sibling read
 * modules (`health.module.ts`): a service over the tenant database with its stateless
 * repositories. The table is written by the worker's `activity-projector`, never here.
 * Registered in `app.module.ts` by the wiring step.
 */
@Module({})
export class ActivityModule {
  static register(): DynamicModule {
    const service: Provider = {
      provide: ACTIVITY_SERVICE,
      inject: [TENANT_DATABASE],
      useFactory: (database: TenantDatabase) => new ActivityService(database),
    };
    return {
      module: ActivityModule,
      providers: [service],
      exports: [service],
      controllers: [ProjectActivityController, ClientActivityController],
    };
  }
}

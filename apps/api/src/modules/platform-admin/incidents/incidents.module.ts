import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import type { TenantDatabase } from '../../../common/database/tenant-context.js';
import { TENANT_DATABASE } from '../../../common/http/tokens.js';
import { platformAdminCore } from '../platform-admin-core.module.js';
import { PLATFORM_INCIDENTS_SERVICE, PlatformIncidentsController } from './incidents.controller.js';
import { PlatformIncidentsRepository } from './incidents.repository.js';
import { PlatformIncidentsService } from './incidents.service.js';
import { WorkspaceIncidentsService } from './workspace-incidents.service.js';
import {
  WORKSPACE_INCIDENTS_SERVICE,
  WorkspaceIncidentsController,
} from './workspace-incidents.controller.js';

/**
 * 56-13 · incident register, plus the A17 workspace incidents read — a platform area module (listed
 * in `platform-admin.areas.ts`).
 */
@Module({})
export class PlatformIncidentsModule {
  static register(): DynamicModule {
    return {
      module: PlatformIncidentsModule,
      imports: [platformAdminCore()],
      providers: [
        {
          provide: PLATFORM_INCIDENTS_SERVICE,
          inject: [TENANT_DATABASE],
          useFactory: (database: TenantDatabase) =>
            new PlatformIncidentsService(new PlatformIncidentsRepository(database)),
        },
        {
          provide: WORKSPACE_INCIDENTS_SERVICE,
          inject: [TENANT_DATABASE],
          useFactory: (database: TenantDatabase) =>
            new WorkspaceIncidentsService(new PlatformIncidentsRepository(database)),
        },
      ],
      // A17: the workspace owner's read sits beside the register it reads (tenant route, global guards).
      controllers: [PlatformIncidentsController, WorkspaceIncidentsController],
    };
  }
}

import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { platformAdminCore } from '../platform-admin-core.module.js';
import { PLATFORM_ADMIN_LOOKUP } from '../platform-admin.guard.js';
import type { PlatformAdminRepository } from '../platform-admin.repository.js';
import {
  PLATFORM_ORGANIZATIONS_SERVICE,
  PlatformOrganizationsController,
} from './organizations.controller.js';
import { PlatformOrganizationsService } from './organizations.service.js';

/** Platform admin · Organizations (listed in `platform-admin.areas.ts`). */
@Module({})
export class PlatformOrganizationsModule {
  static register(): DynamicModule {
    return {
      module: PlatformOrganizationsModule,
      imports: [platformAdminCore()],
      providers: [
        {
          provide: PLATFORM_ORGANIZATIONS_SERVICE,
          inject: [PLATFORM_ADMIN_LOOKUP],
          useFactory: (repository: PlatformAdminRepository) =>
            new PlatformOrganizationsService(repository),
        },
      ],
      controllers: [PlatformOrganizationsController],
    };
  }
}

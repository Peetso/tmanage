import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { platformAdminCore } from '../platform-admin-core.module.js';
import { PLATFORM_ADMIN_LOOKUP } from '../platform-admin.guard.js';
import type { PlatformAdminRepository } from '../platform-admin.repository.js';
import { PLATFORM_ACTIVITY_SERVICE, PlatformActivityController } from './activity.controller.js';
import { PlatformActivityService } from './activity.service.js';

/** Platform admin · Activity (listed in `platform-admin.areas.ts`). */
@Module({})
export class PlatformActivityModule {
  static register(): DynamicModule {
    return {
      module: PlatformActivityModule,
      imports: [platformAdminCore()],
      providers: [
        {
          provide: PLATFORM_ACTIVITY_SERVICE,
          inject: [PLATFORM_ADMIN_LOOKUP],
          useFactory: (repository: PlatformAdminRepository) =>
            new PlatformActivityService(repository),
        },
      ],
      controllers: [PlatformActivityController],
    };
  }
}

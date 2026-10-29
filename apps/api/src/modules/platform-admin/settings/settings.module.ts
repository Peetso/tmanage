import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import {
  PLATFORM_PUBLIC_SIGNUP_DEFAULT,
  platformAdminCore,
} from '../platform-admin-core.module.js';
import { PLATFORM_ADMIN_LOOKUP } from '../platform-admin.guard.js';
import type { PlatformAdminRepository } from '../platform-admin.repository.js';
import { PLATFORM_SETTINGS_SERVICE, PlatformSettingsController } from './settings.controller.js';
import { PlatformSettingsService } from './settings.service.js';

/** Platform admin · Settings (listed in `platform-admin.areas.ts`). */
@Module({})
export class PlatformSettingsModule {
  static register(): DynamicModule {
    return {
      module: PlatformSettingsModule,
      imports: [platformAdminCore()],
      providers: [
        {
          provide: PLATFORM_SETTINGS_SERVICE,
          inject: [PLATFORM_ADMIN_LOOKUP, PLATFORM_PUBLIC_SIGNUP_DEFAULT],
          useFactory: (repository: PlatformAdminRepository, publicSignupDefault: boolean) =>
            new PlatformSettingsService(repository, publicSignupDefault),
        },
      ],
      controllers: [PlatformSettingsController],
    };
  }
}

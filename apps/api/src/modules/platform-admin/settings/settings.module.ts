import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import type { TenantDatabase } from '../../../common/database/tenant-context.js';
import { TENANT_DATABASE } from '../../../common/http/tokens.js';
import {
  PLATFORM_PUBLIC_SIGNUP_DEFAULT,
  platformAdminCore,
} from '../platform-admin-core.module.js';
import { PLATFORM_ADMIN_LOOKUP } from '../platform-admin.guard.js';
import type { PlatformAdminRepository } from '../platform-admin.repository.js';
import {
  PLATFORM_ANNOUNCEMENTS_SERVICE,
  PlatformAnnouncementsController,
} from './announcements.controller.js';
import { PlatformAnnouncementsRepository } from './announcements.repository.js';
import { PlatformAnnouncementsService } from './announcements.service.js';
import { PLATFORM_FLAGS_SERVICE, PlatformFlagsController } from './flags.controller.js';
import { PlatformFlagsRepository } from './flags.repository.js';
import { PlatformFlagsService } from './flags.service.js';
import { PLATFORM_SETTINGS_SERVICE, PlatformSettingsController } from './settings.controller.js';
import { PlatformSettingsRepository } from './settings.repository.js';
import { PlatformSettingsService } from './settings.service.js';

/**
 * Platform admin · Settings (listed in `platform-admin.areas.ts`): D1 General + integrations,
 * D2 feature flags, D3 announcements. D4 maintenance stays in `platform/maintenance.controller.ts`
 * (its own module, registered since wave 9).
 */
@Module({})
export class PlatformSettingsModule {
  static register(): DynamicModule {
    return {
      module: PlatformSettingsModule,
      imports: [platformAdminCore()],
      providers: [
        {
          provide: PLATFORM_SETTINGS_SERVICE,
          inject: [PLATFORM_ADMIN_LOOKUP, PLATFORM_PUBLIC_SIGNUP_DEFAULT, TENANT_DATABASE],
          useFactory: (
            repository: PlatformAdminRepository,
            publicSignupDefault: boolean,
            database: TenantDatabase,
          ) =>
            new PlatformSettingsService(repository, publicSignupDefault, {
              store: new PlatformSettingsRepository(database),
            }),
        },
        {
          provide: PLATFORM_FLAGS_SERVICE,
          inject: [TENANT_DATABASE],
          useFactory: (database: TenantDatabase) =>
            new PlatformFlagsService(new PlatformFlagsRepository(database)),
        },
        {
          provide: PLATFORM_ANNOUNCEMENTS_SERVICE,
          inject: [TENANT_DATABASE],
          useFactory: (database: TenantDatabase) =>
            new PlatformAnnouncementsService(new PlatformAnnouncementsRepository(database)),
        },
      ],
      controllers: [
        PlatformSettingsController,
        PlatformFlagsController,
        PlatformAnnouncementsController,
      ],
    };
  }
}

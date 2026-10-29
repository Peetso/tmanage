import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { PLATFORM_ADMINS_REPOSITORY, platformAdminCore } from '../platform-admin-core.module.js';
import { PLATFORM_ADMIN_ALLOWLIST } from '../platform-admin.guard.js';
import type { PlatformAdminsRepository } from '../platform-admins.repository.js';
import { PLATFORM_TEAM_SERVICE, PlatformTeamController } from './team.controller.js';
import { PlatformTeamService } from './team.service.js';

/** Platform admin · Team (listed in `platform-admin.areas.ts`). */
@Module({})
export class PlatformTeamModule {
  static register(): DynamicModule {
    return {
      module: PlatformTeamModule,
      imports: [platformAdminCore()],
      providers: [
        {
          provide: PLATFORM_TEAM_SERVICE,
          inject: [PLATFORM_ADMINS_REPOSITORY, PLATFORM_ADMIN_ALLOWLIST],
          useFactory: (admins: PlatformAdminsRepository, allowlist: readonly string[]) =>
            new PlatformTeamService(admins, allowlist),
        },
      ],
      controllers: [PlatformTeamController],
    };
  }
}

import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import type { TenantDatabase } from '../../../common/database/tenant-context.js';
import { TENANT_DATABASE } from '../../../common/http/tokens.js';
import { PLATFORM_ADMINS_REPOSITORY, platformAdminCore } from '../platform-admin-core.module.js';
import { PLATFORM_ADMIN_ALLOWLIST } from '../platform-admin.guard.js';
import type { PlatformAdminsRepository } from '../platform-admins.repository.js';
import {
  PLATFORM_ACCESS_REVIEW_SERVICE,
  PlatformAccessReviewController,
} from './access-review.controller.js';
import { AccessReviewRepository } from './access-review.repository.js';
import { AccessReviewService } from './access-review.service.js';
import { PLATFORM_TEAM_SERVICE, PlatformTeamController } from './team.controller.js';
import { PlatformTeamService } from './team.service.js';

/** Platform admin · Team (listed in `platform-admin.areas.ts`), with the 56-21b access review. */
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
        {
          provide: PLATFORM_ACCESS_REVIEW_SERVICE,
          inject: [PLATFORM_ADMINS_REPOSITORY, TENANT_DATABASE, PLATFORM_ADMIN_ALLOWLIST],
          useFactory: (
            admins: PlatformAdminsRepository,
            database: TenantDatabase,
            allowlist: readonly string[],
          ) => new AccessReviewService(admins, new AccessReviewRepository(database), allowlist),
        },
      ],
      // The review's fixed path is registered before the team's `:adminId` routes.
      controllers: [PlatformAccessReviewController, PlatformTeamController],
    };
  }
}

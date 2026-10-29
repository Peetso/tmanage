import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { PLATFORM_RESET_MAILER, platformAdminCore } from '../platform-admin-core.module.js';
import { PLATFORM_ADMIN_LOOKUP } from '../platform-admin.guard.js';
import type { PlatformAdminRepository } from '../platform-admin.repository.js';
import type { ResetMailer } from '../platform-admin.service.js';
import { PLATFORM_PEOPLE_SERVICE, PlatformPeopleController } from './people.controller.js';
import { PlatformPeopleService } from './people.service.js';

/** Platform admin · People (listed in `platform-admin.areas.ts`). */
@Module({})
export class PlatformPeopleModule {
  static register(): DynamicModule {
    return {
      module: PlatformPeopleModule,
      imports: [platformAdminCore()],
      providers: [
        {
          provide: PLATFORM_PEOPLE_SERVICE,
          inject: [PLATFORM_ADMIN_LOOKUP, PLATFORM_RESET_MAILER],
          useFactory: (repository: PlatformAdminRepository, resets: ResetMailer) =>
            new PlatformPeopleService(repository, resets),
        },
      ],
      controllers: [PlatformPeopleController],
    };
  }
}

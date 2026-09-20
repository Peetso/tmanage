import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import {
  MEETINGS_REPOSITORY,
  MEETINGS_SERVICE,
  TENANT_DATABASE,
} from '../../common/http/tokens.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { MeetingsRepository } from './meetings.repository.js';
import { MeetingsService } from './meetings.service.js';
import { MeetingsController } from './meetings.controller.js';

/**
 * CAL-01 / MTG-01 (x90). The calendar module's first vertical slice: meeting read/write.
 *
 * Same shape as `ProjectsModule` — a stateless repository under its token, a service that takes
 * the tenant database and the repository, and one controller. The service needs no audit or
 * outbox dependency this slice (see `MeetingsService`), so its `inject` list is just the
 * database and the repository.
 */
@Module({})
export class CalendarModule {
  static register(): DynamicModule {
    const repository: Provider = {
      provide: MEETINGS_REPOSITORY,
      useFactory: () => new MeetingsRepository(),
    };
    const service: Provider = {
      provide: MEETINGS_SERVICE,
      inject: [TENANT_DATABASE, MEETINGS_REPOSITORY],
      useFactory: (database: TenantDatabase, meetings: MeetingsRepository) =>
        new MeetingsService(database, meetings),
    };

    return {
      module: CalendarModule,
      providers: [repository, service],
      exports: [service],
      controllers: [MeetingsController],
    };
  }
}

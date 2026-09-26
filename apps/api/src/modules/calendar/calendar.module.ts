import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import {
  MEETING_SERIES_REPOSITORY,
  MEETING_SERIES_SERVICE,
  MEETINGS_REPOSITORY,
  MEETINGS_SERVICE,
  TENANT_DATABASE,
} from '../../common/http/tokens.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { MeetingsRepository } from './meetings.repository.js';
import { MeetingNotesRepository } from './meeting-notes.repository.js';
import { MeetingsService } from './meetings.service.js';
import { MeetingsController } from './meetings.controller.js';
import { MeetingSeriesRepository } from './meeting-series.repository.js';
import { MeetingSeriesService } from './meeting-series.service.js';
import { MeetingSeriesController } from './meeting-series.controller.js';
import { ProjectsRepository } from '../projects/projects.repository.js';

/**
 * CAL-01 / MTG-01 (x90). The calendar module's first vertical slice: meeting read/write.
 *
 * Same shape as `ProjectsModule`/`ConversationsModule` — a stateless repository under its token,
 * a service that takes the tenant database and the repository, and one controller. The service
 * needs no audit or outbox dependency this slice (see `MeetingsService`). It does take a second,
 * read-only `ProjectsRepository`, constructed here as `ConversationsModule` constructs its own:
 * a stateless repository is cheap to own a fresh handle on, where injecting the whole projects
 * module would build a second copy of it. The service uses it only to resolve a named project
 * inside the tenant before a write, so an unknown or cross-tenant projectId is a 404, not a 500.
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
        new MeetingsService(
          database,
          meetings,
          new ProjectsRepository(),
          new MeetingNotesRepository(),
        ),
    };

    // CAL recurrence (x129). The meeting-series slice: a stateless repository under its token and a
    // service that takes the tenant database and the repository. Org-scoped — it holds no projects
    // repository because a series names no project and needs no relation resolution.
    const seriesRepository: Provider = {
      provide: MEETING_SERIES_REPOSITORY,
      useFactory: () => new MeetingSeriesRepository(),
    };
    const seriesService: Provider = {
      provide: MEETING_SERIES_SERVICE,
      inject: [TENANT_DATABASE, MEETING_SERIES_REPOSITORY],
      useFactory: (database: TenantDatabase, series: MeetingSeriesRepository) =>
        new MeetingSeriesService(database, series),
    };

    return {
      module: CalendarModule,
      providers: [repository, service, seriesRepository, seriesService],
      exports: [service, seriesService],
      controllers: [MeetingsController, MeetingSeriesController],
    };
  }
}

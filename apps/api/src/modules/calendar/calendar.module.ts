import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import {
  MEETING_ATTENDEES_REPOSITORY,
  MEETING_ATTENDEES_SERVICE,
  MEETINGS_REPOSITORY,
  MEETINGS_SERVICE,
  TENANT_DATABASE,
} from '../../common/http/tokens.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { MeetingsRepository } from './meetings.repository.js';
import { MeetingNotesRepository } from './meeting-notes.repository.js';
import { MeetingsService } from './meetings.service.js';
import { MeetingsController } from './meetings.controller.js';
import { MeetingAttendeesRepository } from './meeting-attendees.repository.js';
import { MeetingAttendeesService } from './meeting-attendees.service.js';
import { MeetingAttendeesController } from './meeting-attendees.controller.js';
import { MeetingIcsController } from './meeting-ics.controller.js';
import { ProjectsRepository } from '../projects/projects.repository.js';
import { MembershipsRepository } from '../tenancy/memberships.repository.js';

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

    // CAL-01 / MTG-01 attendees + RSVP (x126). Its own stateless repository under its token and a
    // service over the tenant database, following the meetings pattern above. The service owns a
    // read-only `MeetingsRepository` (to resolve the path meeting tenant-scoped before authorize)
    // and a read-only `MembershipsRepository` (to resolve the invited member) — both stateless, so
    // a fresh handle is cheaper than injecting the whole owning module.
    const attendeesRepository: Provider = {
      provide: MEETING_ATTENDEES_REPOSITORY,
      useFactory: () => new MeetingAttendeesRepository(),
    };
    const attendeesService: Provider = {
      provide: MEETING_ATTENDEES_SERVICE,
      inject: [TENANT_DATABASE, MEETING_ATTENDEES_REPOSITORY],
      useFactory: (database: TenantDatabase, attendees: MeetingAttendeesRepository) =>
        new MeetingAttendeesService(
          database,
          attendees,
          new MeetingsRepository(),
          new MembershipsRepository(),
        ),
    };

    return {
      module: CalendarModule,
      providers: [repository, service, attendeesRepository, attendeesService],
      exports: [service, attendeesService],
      controllers: [MeetingsController, MeetingAttendeesController, MeetingIcsController],
    };
  }
}

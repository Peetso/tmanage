import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import {
  MEETING_ATTENDEES_REPOSITORY,
  MEETING_ATTENDEES_SERVICE,
  MEETING_SERIES_REPOSITORY,
  MEETING_SERIES_SERVICE,
  MEETINGS_REPOSITORY,
  MEETINGS_SERVICE,
  AUDIT_SERVICE,
  OUTBOX_EVENTS_REPOSITORY,
  TENANT_DATABASE,
} from '../../common/http/tokens.js';
import type { AuditService } from '../audit/audit.service.js';
import { CALENDAR_SYNC } from './calendar-sync.port.js';
import type { CalendarSyncPort } from './calendar-sync.port.js';
import { MeetingCalendarRepository } from './meeting-calendar.repository.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import type { OutboxEventsRepository } from '../platform/outbox-events.repository.js';
import { MeetingsRepository } from './meetings.repository.js';
import { MeetingNotesRepository } from './meeting-notes.repository.js';
import { MeetingsService } from './meetings.service.js';
import { MeetingsController } from './meetings.controller.js';
import { MeetingAttendeesRepository } from './meeting-attendees.repository.js';
import { MeetingAttendeesService } from './meeting-attendees.service.js';
import { MeetingAttendeesController } from './meeting-attendees.controller.js';
import { MeetingIcsController } from './meeting-ics.controller.js';
import { MeetingClientAttendeesRepository } from './meeting-client-attendees.repository.js';
import { PortalMeetingsService } from './portal-meetings.service.js';
import { MeetingJoinService } from './meeting-join.service.js';
import {
  MeetingJoinController,
  MEETING_JOIN_SERVICE,
  PortalMeetingJoinController,
} from './meeting-join.controller.js';
import { PortalMeetingsController, PORTAL_MEETINGS_SERVICE } from './portal-meetings.controller.js';
import { MeetingSeriesRepository } from './meeting-series.repository.js';
import { MeetingSeriesService } from './meeting-series.service.js';
import { MeetingSeriesController } from './meeting-series.controller.js';
import { FocusBlocksRepository } from './focus-blocks.repository.js';
import { FocusBlocksService } from './focus-blocks.service.js';
import { FocusBlocksController, FOCUS_BLOCKS_SERVICE } from './focus-blocks.controller.js';
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
      inject: [
        TENANT_DATABASE,
        MEETINGS_REPOSITORY,
        OUTBOX_EVENTS_REPOSITORY,
        AUDIT_SERVICE,
        // 0237. Provided (globally) by GoogleCalendarModule; absent in suites that omit it.
        { token: CALENDAR_SYNC, optional: true },
      ],
      useFactory: (
        database: TenantDatabase,
        meetings: MeetingsRepository,
        outbox: OutboxEventsRepository,
        audit: AuditService,
        sync?: CalendarSyncPort,
      ) =>
        new MeetingsService(
          database,
          meetings,
          new ProjectsRepository(),
          new MeetingNotesRepository(),
          outbox,
          // Audit gap 8 (COL-09): organizer + chosen attendees are added in the create transaction.
          new MeetingAttendeesRepository(),
          new MembershipsRepository(),
          // BK5: the roster snapshot the "meeting changed" notice is sent to.
          new MeetingClientAttendeesRepository(),
          // 0237: guests, attachments, the provider link; cancel/sync audit; calendar push.
          new MeetingCalendarRepository(),
          audit,
          sync ?? undefined,
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
      inject: [
        TENANT_DATABASE,
        MEETING_ATTENDEES_REPOSITORY,
        OUTBOX_EVENTS_REPOSITORY,
        { token: CALENDAR_SYNC, optional: true },
      ],
      useFactory: (
        database: TenantDatabase,
        attendees: MeetingAttendeesRepository,
        outbox: OutboxEventsRepository,
        sync?: CalendarSyncPort,
      ) =>
        new MeetingAttendeesService(
          database,
          attendees,
          new MeetingsRepository(),
          new MembershipsRepository(),
          outbox,
          // BK5 (0217): client people of the meeting's project as attendees.
          new MeetingClientAttendeesRepository(),
          // 0237: an answer given in TManage goes on to Google/Outlook.
          sync ?? undefined,
        ),
    };

    // BK5 (0217): the client portal's own meetings — only the ones the client person attends.
    const portalMeetingsService: Provider = {
      provide: PORTAL_MEETINGS_SERVICE,
      inject: [TENANT_DATABASE],
      useFactory: (database: TenantDatabase) =>
        new PortalMeetingsService(database, new MeetingClientAttendeesRepository()),
    };

    // 53-12: Join (records attendance), the call link, attendance and quick rooms; staff and portal.
    const meetingJoinService: Provider = {
      provide: MEETING_JOIN_SERVICE,
      inject: [TENANT_DATABASE, MEETINGS_SERVICE],
      useFactory: (database: TenantDatabase, meetings: MeetingsService) =>
        new MeetingJoinService(
          database,
          new MeetingsRepository(),
          new MeetingCalendarRepository(),
          undefined,
          new MeetingClientAttendeesRepository(),
          meetings,
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

    // CAL-04 "Focus block" (x255). A member's own protected time over its own `focus_blocks` table:
    // create/list/delete, self-scoped by the acting membership. It owns a stateless repository and a
    // service over the tenant database — no projects or memberships repository, because a focus block
    // names no other entity to resolve. The token is the service's own symbol (declared beside the
    // controller); the service constructs its repository, so no separate repository provider is needed.
    const focusBlocksService: Provider = {
      provide: FOCUS_BLOCKS_SERVICE,
      inject: [TENANT_DATABASE],
      useFactory: (database: TenantDatabase) =>
        new FocusBlocksService(database, new FocusBlocksRepository()),
    };

    return {
      module: CalendarModule,
      providers: [
        repository,
        service,
        attendeesRepository,
        attendeesService,
        seriesRepository,
        seriesService,
        focusBlocksService,
        portalMeetingsService,
        meetingJoinService,
      ],
      exports: [service, attendeesService, seriesService],
      controllers: [
        MeetingsController,
        MeetingAttendeesController,
        MeetingIcsController,
        MeetingSeriesController,
        FocusBlocksController,
        PortalMeetingsController,
        MeetingJoinController,
        PortalMeetingJoinController,
      ],
    };
  }
}

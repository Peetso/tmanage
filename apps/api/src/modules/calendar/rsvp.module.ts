import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import { TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { MeetingsRepository } from './meetings.repository.js';
import { MEETING_RSVP_REPOSITORY, MeetingRsvpRepository } from './rsvp.repository.js';
import { MEETING_RSVP_SERVICE, MeetingRsvpService } from './rsvp.service.js';
import { MeetingRsvpController } from './rsvp.controller.js';

/**
 * CAL meeting RSVP (x240) — the wiring for a member's own meeting response.
 *
 * A separate module from {@link CalendarModule} on purpose, like {@link MeetingAgendaModule}: the
 * sibling calendar slices each add their own controller, and registering each as its own module in
 * `app.module.ts` — the integrator-reconciled append point — keeps them file-disjoint rather than
 * all editing `calendar.module.ts`. The service owns a read-only {@link MeetingsRepository} to
 * resolve the path meeting tenant-scoped before authorize (the Known-trap order); a stateless
 * repository is cheaper to own a fresh handle on than injecting the whole owning module.
 */
@Module({})
export class MeetingRsvpModule {
  static register(): DynamicModule {
    const repository: Provider = {
      provide: MEETING_RSVP_REPOSITORY,
      useClass: MeetingRsvpRepository,
    };
    const service: Provider = {
      provide: MEETING_RSVP_SERVICE,
      inject: [TENANT_DATABASE, MEETING_RSVP_REPOSITORY],
      useFactory: (database: TenantDatabase, rsvps: MeetingRsvpRepository) =>
        new MeetingRsvpService(database, rsvps, new MeetingsRepository()),
    };

    return {
      module: MeetingRsvpModule,
      providers: [repository, service],
      exports: [service],
      controllers: [MeetingRsvpController],
    };
  }
}

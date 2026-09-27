import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import { TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { MeetingsRepository } from './meetings.repository.js';
import { MEETING_TIME_POLL_REPOSITORY, MeetingTimePollRepository } from './time-poll.repository.js';
import { MEETING_TIME_POLL_SERVICE, MeetingTimePollService } from './time-poll.service.js';
import { MeetingTimePollController } from './time-poll.controller.js';

/**
 * CAL meeting time-option poll (x298) — the wiring for proposing candidate slots and voting on them.
 *
 * A separate module from {@link CalendarModule}, like {@link MeetingRsvpModule}: the sibling
 * calendar slices each add their own controller, and registering each as its own module in
 * `app.module.ts` — the integrator-reconciled append point — keeps them file-disjoint rather than
 * all editing `calendar.module.ts`. The service owns a read-only {@link MeetingsRepository} to
 * resolve the path meeting tenant-scoped before authorize (the Known-trap order); a stateless
 * repository is cheaper to own a fresh handle on than injecting the whole owning module.
 */
@Module({})
export class MeetingTimePollModule {
  static register(): DynamicModule {
    const repository: Provider = {
      provide: MEETING_TIME_POLL_REPOSITORY,
      useClass: MeetingTimePollRepository,
    };
    const service: Provider = {
      provide: MEETING_TIME_POLL_SERVICE,
      inject: [TENANT_DATABASE, MEETING_TIME_POLL_REPOSITORY],
      useFactory: (database: TenantDatabase, polls: MeetingTimePollRepository) =>
        new MeetingTimePollService(database, polls, new MeetingsRepository()),
    };

    return {
      module: MeetingTimePollModule,
      providers: [repository, service],
      exports: [service],
      controllers: [MeetingTimePollController],
    };
  }
}

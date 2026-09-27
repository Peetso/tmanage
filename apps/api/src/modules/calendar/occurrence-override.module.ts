import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import { MEETING_OCCURRENCE_OVERRIDE_SERVICE, TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { MeetingOccurrenceOverrideRepository } from './occurrence-override.repository.js';
import { MeetingSeriesRepository } from './meeting-series.repository.js';
import { OccurrenceOverrideService } from './occurrence-override.service.js';
import { OccurrenceOverrideController } from './occurrence-override.controller.js';

/**
 * CAL per-occurrence override (x213) — the wiring for the per-occurrence exception endpoints.
 *
 * A separate module from {@link CalendarModule} on purpose, the same reason the agenda slice is: the
 * sibling calendar slices each register their own module in `app.module.ts` (the integrator-reconciled
 * append point) so they stay file-disjoint rather than all editing `calendar.module.ts`. The service
 * takes the (global) tenant database and owns two stateless repositories — its own override repository
 * and a read-only {@link MeetingSeriesRepository} to resolve the series tenant-scoped before it acts —
 * both cheap to hold a fresh handle on, where injecting the whole calendar module would build a second
 * copy anyway.
 */
@Module({})
export class OccurrenceOverrideModule {
  static register(): DynamicModule {
    const service: Provider = {
      provide: MEETING_OCCURRENCE_OVERRIDE_SERVICE,
      inject: [TENANT_DATABASE],
      useFactory: (database: TenantDatabase) =>
        new OccurrenceOverrideService(
          database,
          new MeetingOccurrenceOverrideRepository(),
          new MeetingSeriesRepository(),
        ),
    };

    return {
      module: OccurrenceOverrideModule,
      providers: [service],
      exports: [service],
      controllers: [OccurrenceOverrideController],
    };
  }
}

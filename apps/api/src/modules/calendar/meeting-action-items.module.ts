import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import { TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { MEETING_ACTION_ITEMS_SERVICE } from './meeting-action-items.tokens.js';
import { MeetingActionItemsRepository } from './meeting-action-items.repository.js';
import { MeetingActionItemsService } from './meeting-action-items.service.js';
import { MeetingActionItemsController } from './meeting-action-items.controller.js';
import { MeetingsRepository } from './meetings.repository.js';
import { MembershipsRepository } from '../tenancy/memberships.repository.js';

/**
 * CAL / MTG-03 meeting action items (x266) — the wiring for the action-items slice.
 *
 * A separate module from {@link CalendarModule} on purpose, exactly as {@link MeetingAgendaModule}
 * (x127) is: registering each sibling calendar slice as its own module in `app.module.ts` — the
 * integrator-reconciled append point — keeps them file-disjoint rather than all editing
 * `calendar.module.ts`. The service owns a read-only {@link MeetingsRepository} (to resolve the path
 * meeting tenant-scoped before authorize) and a read-only {@link MembershipsRepository} (to resolve
 * a supplied owner) — both stateless, so a fresh handle is cheaper than injecting the whole owning
 * module.
 */
@Module({})
export class MeetingActionItemsModule {
  static register(): DynamicModule {
    const service: Provider = {
      provide: MEETING_ACTION_ITEMS_SERVICE,
      inject: [TENANT_DATABASE],
      useFactory: (database: TenantDatabase) =>
        new MeetingActionItemsService(
          database,
          new MeetingActionItemsRepository(),
          new MeetingsRepository(),
          new MembershipsRepository(),
        ),
    };

    return {
      module: MeetingActionItemsModule,
      providers: [service],
      exports: [service],
      controllers: [MeetingActionItemsController],
    };
  }
}

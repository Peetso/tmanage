import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import { TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { MeetingsRepository } from './meetings.repository.js';
import { MeetingNotesRepository } from './meeting-notes.repository.js';
import {
  AGENDA_TEMPLATES_REPOSITORY,
  AgendaTemplatesRepository,
} from './agenda-templates.repository.js';
import { AGENDA_TEMPLATES_SERVICE, AgendaTemplatesService } from './agenda-templates.service.js';
import { AgendaTemplatesController } from './agenda-templates.controller.js';

/**
 * CAL agenda templates (x314) — the wiring for reusable meeting agenda templates.
 *
 * A separate module from {@link CalendarModule} on purpose, like {@link MeetingAgendaModule} and
 * {@link MeetingRsvpModule}: the sibling calendar slices each add their own controller, and
 * registering each as its own module in `app.module.ts` — the integrator-reconciled append point —
 * keeps them file-disjoint rather than all editing `calendar.module.ts`. The service owns a
 * read-only {@link MeetingsRepository} to resolve the path meeting tenant-scoped before authorize on
 * apply (the Known-trap order), and a {@link MeetingNotesRepository} to seed the meeting's existing
 * item store (x105) without a schema edit there; both are stateless, so a fresh handle is cheap.
 */
@Module({})
export class AgendaTemplatesModule {
  static register(): DynamicModule {
    const repository: Provider = {
      provide: AGENDA_TEMPLATES_REPOSITORY,
      useClass: AgendaTemplatesRepository,
    };
    const service: Provider = {
      provide: AGENDA_TEMPLATES_SERVICE,
      inject: [TENANT_DATABASE, AGENDA_TEMPLATES_REPOSITORY],
      useFactory: (database: TenantDatabase, templates: AgendaTemplatesRepository) =>
        new AgendaTemplatesService(
          database,
          templates,
          new MeetingsRepository(),
          new MeetingNotesRepository(),
        ),
    };

    return {
      module: AgendaTemplatesModule,
      providers: [repository, service],
      exports: [service],
      controllers: [AgendaTemplatesController],
    };
  }
}

import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { MEETING_AGENDA_REPOSITORY, MeetingAgendaRepository } from './meeting-agenda.repository.js';
import { MeetingAgendaController } from './meeting-agenda.controller.js';

/**
 * CAL agenda / day view (x127) — the wiring for the read-only meeting agenda.
 *
 * A separate module from {@link CalendarModule} on purpose: the sibling calendar slices (attendees,
 * ICS) each add their own controller, and registering each as its own module in `app.module.ts` —
 * the integrator-reconciled append point — keeps them file-disjoint rather than all editing
 * `calendar.module.ts`. It depends on nothing but the (global) tenant database: the stateless
 * {@link MeetingAgendaRepository} is provided by its class token and the controller reads through it.
 */
@Module({})
export class MeetingAgendaModule {
  static register(): DynamicModule {
    return {
      module: MeetingAgendaModule,
      providers: [{ provide: MEETING_AGENDA_REPOSITORY, useClass: MeetingAgendaRepository }],
      controllers: [MeetingAgendaController],
    };
  }
}

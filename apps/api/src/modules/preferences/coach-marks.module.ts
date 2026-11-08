import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import { COACH_MARKS_REPOSITORY, CoachMarksController } from './coach-marks.controller.js';
import { CoachMarksRepository } from './coach-marks.repository.js';

/** Row 55-09 wiring: the caller's own first-visit tour state, kept in `prefs_json`. */
@Module({})
export class CoachMarksModule {
  static register(): DynamicModule {
    const repository: Provider = {
      provide: COACH_MARKS_REPOSITORY,
      useFactory: () => new CoachMarksRepository(),
    };
    return {
      module: CoachMarksModule,
      providers: [repository],
      controllers: [CoachMarksController],
    };
  }
}

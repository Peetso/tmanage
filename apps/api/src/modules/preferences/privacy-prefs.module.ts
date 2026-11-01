import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import {
  PRIVACY_PREFERENCES_REPOSITORY,
  PrivacyPreferencesController,
} from './privacy-prefs.controller.js';
import { PrivacyPreferencesRepository } from './privacy-prefs.repository.js';

/** R7 privacy preferences wiring (F4): the caller's own "show last seen" toggle. */
@Module({})
export class PrivacyPreferencesModule {
  static register(): DynamicModule {
    const repository: Provider = {
      provide: PRIVACY_PREFERENCES_REPOSITORY,
      useFactory: () => new PrivacyPreferencesRepository(),
    };
    return {
      module: PrivacyPreferencesModule,
      providers: [repository],
      controllers: [PrivacyPreferencesController],
    };
  }
}

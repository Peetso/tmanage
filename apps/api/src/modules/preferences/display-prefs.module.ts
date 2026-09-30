import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import {
  DISPLAY_PREFERENCES_REPOSITORY,
  DISPLAY_PREFERENCES_SERVICE,
} from '../../common/http/tokens.js';
import { DisplayPreferencesController } from './display-prefs.controller.js';
import { DisplayPreferencesRepository } from './display-prefs.repository.js';
import { DisplayPreferencesService } from './display-prefs.service.js';

/**
 * PREF-DISPLAY display-preferences wiring (module 20, x285).
 *
 * A repository, a service and the caller's-own GET/PUT route over `TENANT_DATABASE`. Kept in a
 * module of its own — file-disjoint from the sibling preferences slices — so neither slice edits a
 * file the other appends to. The service depends only on the global tenant database and this
 * repository; there is no tenant object to resolve, so it imports nothing else. Every provider
 * carries an explicit token (ADR-0003).
 */
@Module({})
export class DisplayPreferencesModule {
  static register(): DynamicModule {
    const repository: Provider = {
      provide: DISPLAY_PREFERENCES_REPOSITORY,
      useFactory: () => new DisplayPreferencesRepository(),
    };
    const service: Provider = {
      provide: DISPLAY_PREFERENCES_SERVICE,
      useClass: DisplayPreferencesService,
    };

    return {
      module: DisplayPreferencesModule,
      providers: [repository, service],
      controllers: [DisplayPreferencesController],
    };
  }
}

import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import { HOME_WIDGET_PREFS_REPOSITORY } from '../../common/http/tokens.js';
import { HomeWidgetPrefsController } from './widget-prefs.controller.js';
import { HomeWidgetPrefsRepository } from './widget-prefs.repository.js';

/**
 * Home widget-preferences wiring (module 4 Home / My Day, x243).
 *
 * A service and the caller's-own GET/PUT route over `TENANT_DATABASE`. Kept in a module of its own —
 * file-disjoint from the rest of the Home module — so this slice edits no file another Home slice
 * appends to. The controller depends only on the global tenant database and this service; there is no
 * tenant object to resolve, so it imports nothing else. Every provider carries an explicit token
 * (ADR-0003).
 */
@Module({})
export class HomeWidgetPrefsModule {
  static register(): DynamicModule {
    const service: Provider = {
      provide: HOME_WIDGET_PREFS_REPOSITORY,
      useFactory: () => new HomeWidgetPrefsRepository(),
    };

    return {
      module: HomeWidgetPrefsModule,
      providers: [service],
      controllers: [HomeWidgetPrefsController],
    };
  }
}

import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { PreferencesController } from './preferences.controller.js';

/**
 * PREF-001 appearance & accessibility preferences wiring (x182).
 *
 * The controller injects `TENANT_DATABASE` (a global provider) and defaults its own
 * `PreferencesRepository`, so this module has nothing to construct — it only registers the caller's-
 * own GET/PUT route. Kept in a module of its own rather than folded into an existing one: preferences
 * touch no other module's services, so sharing a module would import a dependency graph this route has
 * no use for.
 */
@Module({})
export class PreferencesModule {
  static register(): DynamicModule {
    return {
      module: PreferencesModule,
      controllers: [PreferencesController],
    };
  }
}

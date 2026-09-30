import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import { STARTUP_PREFS_REPOSITORY } from '../../common/http/tokens.js';
import { StartupPrefsController } from './startup-prefs.controller.js';
import { StartupPrefsRepository } from './startup-prefs.repository.js';

/**
 * PREF-STARTUP default startup landing view wiring (module 20, x287).
 *
 * A repository (the member's-own store) and the caller's-own GET/PUT `/me/startup` routes over
 * `TENANT_DATABASE`; the landing-key validation is the pure `parseStartupInput` in the service, which
 * needs no injection. Kept in a module of its own — file-disjoint from the sibling preferences slices
 * (x183/x215) — so neither slice edits a file the other appends to. The controller depends only on
 * the global tenant database and this repository; there is no tenant object to resolve, so it imports
 * nothing else. Every provider carries an explicit token (ADR-0003).
 */
@Module({})
export class StartupPrefsModule {
  static register(): DynamicModule {
    const repository: Provider = {
      provide: STARTUP_PREFS_REPOSITORY,
      useFactory: () => new StartupPrefsRepository(),
    };

    return {
      module: StartupPrefsModule,
      providers: [repository],
      controllers: [StartupPrefsController],
    };
  }
}

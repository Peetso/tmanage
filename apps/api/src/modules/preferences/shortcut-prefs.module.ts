import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import { SHORTCUT_PREFS_REPOSITORY } from '../../common/http/tokens.js';
import { ShortcutPrefsController } from './shortcut-prefs.controller.js';
import { ShortcutPrefsRepository } from './shortcut-prefs.repository.js';

/**
 * PRF keyboard shortcuts wiring (module 20, x286).
 *
 * A repository (the member's-own override store) and the caller's-own GET/PUT/DELETE routes over
 * `TENANT_DATABASE`; the allowlist, chord grammar, and resolve are the pure functions in the service,
 * which need no injection. Kept in a module of its own — file-disjoint from the sibling preferences
 * slices (x182/x183/x215) — so neither slice edits a file the other appends to. The controller depends
 * only on the global tenant database and this repository; there is no tenant object to resolve, so it
 * imports nothing else. Every provider carries an explicit token (ADR-0003).
 */
@Module({})
export class ShortcutPrefsModule {
  static register(): DynamicModule {
    const repository: Provider = {
      provide: SHORTCUT_PREFS_REPOSITORY,
      useFactory: () => new ShortcutPrefsRepository(),
    };

    return {
      module: ShortcutPrefsModule,
      providers: [repository],
      controllers: [ShortcutPrefsController],
    };
  }
}

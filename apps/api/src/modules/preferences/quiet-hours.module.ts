import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import { QUIET_HOURS_REPOSITORY } from '../../common/http/tokens.js';
import { QuietHoursController } from './quiet-hours.controller.js';
import { QuietHoursRepository } from './quiet-hours.repository.js';

/**
 * PREF-QUIET quiet-hours wiring (module 20, x215).
 *
 * A repository (the member's-own store) and the caller's-own GET/PUT/active routes over
 * `TENANT_DATABASE`; the active-window decision is the pure `isWithinQuietHours` in the service, which
 * needs no injection. Kept in a module of its own — file-disjoint from the sibling preferences slices
 * (x182/x183) — so neither slice edits a file the other appends to. The controller depends only on the
 * global tenant database and this repository; there is no tenant object to resolve, so it imports
 * nothing else. Every provider carries an explicit token (ADR-0003).
 */
@Module({})
export class QuietHoursModule {
  static register(): DynamicModule {
    const repository: Provider = {
      provide: QUIET_HOURS_REPOSITORY,
      useFactory: () => new QuietHoursRepository(),
    };

    return {
      module: QuietHoursModule,
      providers: [repository],
      controllers: [QuietHoursController],
    };
  }
}

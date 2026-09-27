import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import { A11Y_PREFERENCES_REPOSITORY } from '../../common/http/tokens.js';
import { A11yPreferencesController } from './a11y.controller.js';
import { A11yPreferencesRepository } from './a11y.repository.js';

/**
 * A11Y-183 accessibility-preferences wiring (module 20, x183).
 *
 * A repository and the caller's-own GET/PUT route over `TENANT_DATABASE`. Kept in a module of its
 * own — file-disjoint from the sibling preferences slice (x182) — so neither slice edits a file the
 * other appends to. The controller depends only on the global tenant database and this repository;
 * there is no tenant object to resolve, so it imports nothing else. Every provider carries an
 * explicit token (ADR-0003).
 */
@Module({})
export class A11yPreferencesModule {
  static register(): DynamicModule {
    const repository: Provider = {
      provide: A11Y_PREFERENCES_REPOSITORY,
      useFactory: () => new A11yPreferencesRepository(),
    };

    return {
      module: A11yPreferencesModule,
      providers: [repository],
      controllers: [A11yPreferencesController],
    };
  }
}

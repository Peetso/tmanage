import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import {
  A11Y_PREFERENCES_REPOSITORY,
  PORTAL_A11Y_PREFERENCES_SERVICE,
  TENANT_DATABASE,
} from '../../common/http/tokens.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { A11yPreferencesController } from './a11y.controller.js';
import { A11yPreferencesRepository } from './a11y.repository.js';
import { PortalA11yPreferencesController } from './portal-a11y.controller.js';
import { PortalA11yPreferencesService } from './portal-a11y.service.js';

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
    // PORTALA11Y: the client portal route, over the same repository and validation.
    const portalService: Provider = {
      provide: PORTAL_A11Y_PREFERENCES_SERVICE,
      useFactory: (database: TenantDatabase, preferences: A11yPreferencesRepository) =>
        new PortalA11yPreferencesService(database, preferences),
      inject: [TENANT_DATABASE, A11Y_PREFERENCES_REPOSITORY],
    };

    return {
      module: A11yPreferencesModule,
      providers: [repository, portalService],
      controllers: [A11yPreferencesController, PortalA11yPreferencesController],
    };
  }
}

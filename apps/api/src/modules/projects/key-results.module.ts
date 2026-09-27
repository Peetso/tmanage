import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import {
  KEY_RESULTS_REPOSITORY,
  KEY_RESULTS_SERVICE,
  TENANT_DATABASE,
} from '../../common/http/tokens.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { KeyResultsRepository } from './key-results.repository.js';
import { KeyResultsService } from './key-results.service.js';
import { KeyResultsController } from './key-results.controller.js';
import { ProjectObjectivesRepository } from './project-objectives.repository.js';

/**
 * PROJ / module 8 (x207). The key-results module — an objective's key results (create, list, update).
 *
 * Same shape as `ObjectiveWorkLinksModule` — a stateless repository under its token, a service that
 * takes the tenant database and the repository, and one controller. The service takes one more
 * read-only, stateless `ProjectObjectivesRepository` to resolve a named objective inside the tenant
 * (and its project for the relation gate) before a write, so an unknown or cross-tenant `objectiveId`
 * is a 404, not a foreign-key 500.
 */
@Module({})
export class KeyResultsModule {
  static register(): DynamicModule {
    const repository: Provider = {
      provide: KEY_RESULTS_REPOSITORY,
      useFactory: () => new KeyResultsRepository(),
    };
    const service: Provider = {
      provide: KEY_RESULTS_SERVICE,
      inject: [TENANT_DATABASE, KEY_RESULTS_REPOSITORY],
      useFactory: (database: TenantDatabase, keyResults: KeyResultsRepository) =>
        new KeyResultsService(database, keyResults, new ProjectObjectivesRepository()),
    };

    return {
      module: KeyResultsModule,
      providers: [repository, service],
      exports: [service],
      controllers: [KeyResultsController],
    };
  }
}

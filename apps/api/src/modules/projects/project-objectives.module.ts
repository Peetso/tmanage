import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import {
  PROJECT_OBJECTIVES_REPOSITORY,
  PROJECT_OBJECTIVES_SERVICE,
  TENANT_DATABASE,
} from '../../common/http/tokens.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { ProjectObjectivesRepository } from './project-objectives.repository.js';
import { ProjectObjectivesService } from './project-objectives.service.js';
import { ProjectObjectivesController } from './project-objectives.controller.js';
import { ProjectsRepository } from './projects.repository.js';

/**
 * PROJ / module 8 (x124). The project-objectives module — a project's objectives (create, list,
 * transition).
 *
 * Same shape as `DecisionsModule` — a stateless repository under its token, a service that takes the
 * tenant database and the repository, and one controller. The service takes one more read-only,
 * stateless repository, constructed here as `DecisionsModule` constructs its own: a
 * `ProjectsRepository` to resolve a named project inside the tenant before a write (so an unknown or
 * cross-tenant `projectId` is a 404, not a foreign-key 500).
 */
@Module({})
export class ProjectObjectivesModule {
  static register(): DynamicModule {
    const repository: Provider = {
      provide: PROJECT_OBJECTIVES_REPOSITORY,
      useFactory: () => new ProjectObjectivesRepository(),
    };
    const service: Provider = {
      provide: PROJECT_OBJECTIVES_SERVICE,
      inject: [TENANT_DATABASE, PROJECT_OBJECTIVES_REPOSITORY],
      useFactory: (database: TenantDatabase, objectives: ProjectObjectivesRepository) =>
        new ProjectObjectivesService(database, objectives, new ProjectsRepository()),
    };

    return {
      module: ProjectObjectivesModule,
      providers: [repository, service],
      exports: [service],
      controllers: [ProjectObjectivesController],
    };
  }
}

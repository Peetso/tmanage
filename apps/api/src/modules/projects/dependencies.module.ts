import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import {
  PROJECT_DEPENDENCIES_REPOSITORY,
  PROJECT_DEPENDENCIES_SERVICE,
  TENANT_DATABASE,
} from '../../common/http/tokens.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { ProjectsRepository } from './projects.repository.js';
import { ProjectDependenciesRepository } from './dependencies.repository.js';
import { ProjectDependenciesService } from './dependencies.service.js';
import { ProjectDependenciesController } from './dependencies.controller.js';

/**
 * PROJ / cross-project dependencies (x309). The project-dependencies module — record, list and
 * remove the directed dependency edges between two projects.
 *
 * Same shape as `MilestoneLinksModule` — a stateless repository under its token, a service that
 * takes the tenant database and the repository. The service takes one more read-only, stateless
 * repository constructed here: a `ProjectsRepository` to resolve both project ids tenant-scoped
 * before a write, so an unknown or cross-tenant id is a 404, not a foreign-key 500.
 */
@Module({})
export class ProjectDependenciesModule {
  static register(): DynamicModule {
    const repository: Provider = {
      provide: PROJECT_DEPENDENCIES_REPOSITORY,
      useFactory: () => new ProjectDependenciesRepository(),
    };
    const service: Provider = {
      provide: PROJECT_DEPENDENCIES_SERVICE,
      inject: [TENANT_DATABASE, PROJECT_DEPENDENCIES_REPOSITORY],
      useFactory: (database: TenantDatabase, dependencies: ProjectDependenciesRepository) =>
        new ProjectDependenciesService(database, dependencies, new ProjectsRepository()),
    };

    return {
      module: ProjectDependenciesModule,
      providers: [repository, service],
      exports: [service],
      controllers: [ProjectDependenciesController],
    };
  }
}

import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import {
  PROJECT_PHASES_REPOSITORY,
  PROJECT_PHASES_SERVICE,
  TENANT_DATABASE,
} from '../../common/http/tokens.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { ProjectPhasesRepository } from './phases.repository.js';
import { ProjectPhasesService } from './phases.service.js';
import { ProjectPhasesController } from './phases.controller.js';
import { ProjectsRepository } from './projects.repository.js';

/**
 * PROJ / module 8 (x294). The project timeline-phases module — define/list/delete a phase and assign
 * a milestone to a phase.
 *
 * Same shape as `ProjectRiskRegisterModule`: a stateless repository under its token, a service that
 * takes the tenant database and the repository, and one controller. The service takes one more
 * read-only, stateless `ProjectsRepository` to resolve a named project inside the tenant before a
 * write (so an unknown or cross-tenant `projectId` is a 404, not a foreign-key 500).
 */
@Module({})
export class ProjectPhasesModule {
  static register(): DynamicModule {
    const repository: Provider = {
      provide: PROJECT_PHASES_REPOSITORY,
      useFactory: () => new ProjectPhasesRepository(),
    };
    const service: Provider = {
      provide: PROJECT_PHASES_SERVICE,
      inject: [TENANT_DATABASE, PROJECT_PHASES_REPOSITORY],
      useFactory: (database: TenantDatabase, phases: ProjectPhasesRepository) =>
        new ProjectPhasesService(database, phases, new ProjectsRepository()),
    };

    return {
      module: ProjectPhasesModule,
      providers: [repository, service],
      exports: [service],
      controllers: [ProjectPhasesController],
    };
  }
}

import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import {
  PROJECT_HEALTH_REPOSITORY,
  PROJECT_HEALTH_SERVICE,
  TENANT_DATABASE,
} from '../../common/http/tokens.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { ProjectsRepository } from './projects.repository.js';
import { ProjectHealthRepository } from './health.repository.js';
import { ProjectHealthService } from './health.service.js';
import { ProjectHealthController, ProjectHealthListController } from './health.controller.js';

/**
 * PROJ / module 8 (x208). The project-health module — the read-only computed health roll-up across
 * the caller's visible projects, and per project.
 *
 * Same shape as the sibling read modules (`portfolio.module.ts`): a stateless repository under its
 * token and a service that takes the tenant database, a read-only `ProjectsRepository` (to list/find
 * the tenant's projects for the relation filter) and the health aggregate repository. No new table,
 * so nothing to register in the schema/tenant-guard/grant/migrator quartet.
 */
@Module({})
export class ProjectHealthModule {
  static register(): DynamicModule {
    const repository: Provider = {
      provide: PROJECT_HEALTH_REPOSITORY,
      useFactory: () => new ProjectHealthRepository(),
    };
    const service: Provider = {
      provide: PROJECT_HEALTH_SERVICE,
      inject: [TENANT_DATABASE, PROJECT_HEALTH_REPOSITORY],
      useFactory: (database: TenantDatabase, health: ProjectHealthRepository) =>
        new ProjectHealthService(database, new ProjectsRepository(), health),
    };

    return {
      module: ProjectHealthModule,
      providers: [repository, service],
      exports: [service],
      controllers: [ProjectHealthListController, ProjectHealthController],
    };
  }
}

import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import {
  PROJECT_BASELINE_REPOSITORY,
  PROJECT_BASELINE_SERVICE,
  TENANT_DATABASE,
} from '../../common/http/tokens.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { ProjectBaselineRepository } from './baseline.repository.js';
import { ProjectBaselineService } from './baseline.service.js';
import { ProjectBaselineController } from './baseline.controller.js';
import { ProjectsRepository } from './projects.repository.js';

/**
 * PROJ / module 8 (x295). The milestone-plan baseline module — snapshot the current plan, list the
 * baselines, and read a variance view (today's dates vs the frozen plan).
 *
 * Same shape as `ProjectRiskRegisterModule`: a stateless repository under its token, a service that
 * takes the tenant database and the repository, and one controller. The service takes one more
 * read-only, stateless `ProjectsRepository` to resolve a named project inside the tenant before a
 * write (so an unknown or cross-tenant `projectId` is a 404, not a foreign-key 500).
 */
@Module({})
export class ProjectBaselineModule {
  static register(): DynamicModule {
    const repository: Provider = {
      provide: PROJECT_BASELINE_REPOSITORY,
      useFactory: () => new ProjectBaselineRepository(),
    };
    const service: Provider = {
      provide: PROJECT_BASELINE_SERVICE,
      inject: [TENANT_DATABASE, PROJECT_BASELINE_REPOSITORY],
      useFactory: (database: TenantDatabase, baselines: ProjectBaselineRepository) =>
        new ProjectBaselineService(database, baselines, new ProjectsRepository()),
    };

    return {
      module: ProjectBaselineModule,
      providers: [repository, service],
      exports: [service],
      controllers: [ProjectBaselineController],
    };
  }
}

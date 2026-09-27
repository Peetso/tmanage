import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import {
  PROJECT_STATUS_UPDATES_REPOSITORY,
  PROJECT_STATUS_UPDATES_SERVICE,
  TENANT_DATABASE,
} from '../../common/http/tokens.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { ProjectStatusUpdatesRepository } from './status-updates.repository.js';
import { ProjectStatusUpdatesService } from './status-updates.service.js';
import { ProjectStatusUpdatesController } from './status-updates.controller.js';
import { ProjectsRepository } from './projects.repository.js';

/**
 * PROJ / module 8 (x235). The internal status-update module — a project's internal status changelog
 * (post, list newest-first with keyset paging).
 *
 * Same shape as `ProjectRiskRegisterModule`: a stateless repository under its token, a service that
 * takes the tenant database and the repository, and one controller. The service takes one more
 * read-only, stateless `ProjectsRepository` to resolve a named project inside the tenant before a
 * write (so an unknown or cross-tenant `projectId` is a 404, not a foreign-key 500).
 */
@Module({})
export class ProjectStatusUpdatesModule {
  static register(): DynamicModule {
    const repository: Provider = {
      provide: PROJECT_STATUS_UPDATES_REPOSITORY,
      useFactory: () => new ProjectStatusUpdatesRepository(),
    };
    const service: Provider = {
      provide: PROJECT_STATUS_UPDATES_SERVICE,
      inject: [TENANT_DATABASE, PROJECT_STATUS_UPDATES_REPOSITORY],
      useFactory: (database: TenantDatabase, updates: ProjectStatusUpdatesRepository) =>
        new ProjectStatusUpdatesService(database, updates, new ProjectsRepository()),
    };

    return {
      module: ProjectStatusUpdatesModule,
      providers: [repository, service],
      exports: [service],
      controllers: [ProjectStatusUpdatesController],
    };
  }
}

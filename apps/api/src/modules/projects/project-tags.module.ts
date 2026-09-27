import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import { PROJECT_TAGS_SERVICE, TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { ProjectTagsRepository } from './project-tags.repository.js';
import { ProjectTagsService } from './project-tags.service.js';
import { ProjectTagsController } from './project-tags.controller.js';
import { ProjectsRepository } from './projects.repository.js';

/**
 * PROJ / portfolio (x267). The project-tags module — an org-defined tag taxonomy and its per-project
 * assignments (define/list definitions, assign/list/remove on a project).
 *
 * Same shape as `ProjectObjectivesModule`: a service that takes the tenant database and its own
 * stateless repository, plus one more read-only stateless `ProjectsRepository` to resolve a named
 * project inside the tenant before a write (so an unknown or cross-tenant `projectId` is a 404, not a
 * foreign-key 500), and one controller.
 */
@Module({})
export class ProjectTagsModule {
  static register(): DynamicModule {
    const service: Provider = {
      provide: PROJECT_TAGS_SERVICE,
      inject: [TENANT_DATABASE],
      useFactory: (database: TenantDatabase) =>
        new ProjectTagsService(database, new ProjectTagsRepository(), new ProjectsRepository()),
    };

    return {
      module: ProjectTagsModule,
      providers: [service],
      exports: [service],
      controllers: [ProjectTagsController],
    };
  }
}

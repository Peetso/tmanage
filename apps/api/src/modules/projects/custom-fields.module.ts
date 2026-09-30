import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import {
  PROJECT_CUSTOM_FIELDS_REPOSITORY,
  PROJECT_CUSTOM_FIELDS_SERVICE,
  TENANT_DATABASE,
} from '../../common/http/tokens.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { ProjectCustomFieldsRepository } from './custom-fields.repository.js';
import { ProjectCustomFieldsService } from './custom-fields.service.js';
import {
  ProjectCustomFieldDefinitionsController,
  ProjectCustomFieldValuesController,
} from './custom-fields.controller.js';
import { ProjectsRepository } from './projects.repository.js';

/**
 * PROJ / module 8 (x310). Custom fields for projects — define org-level fields, set a value per
 * project, read a project's resolved field+value map.
 *
 * Same shape as `ProjectStatusUpdatesModule`: a stateless repository under its token and a service
 * that takes the tenant database and the repository. The service also takes a read-only, stateless
 * `ProjectsRepository` to resolve a named project inside the tenant before a value write (so an
 * unknown or cross-tenant `projectId` is a 404, not a dangling value row). Two controllers — the
 * org-scoped definitions surface and the project-scoped values surface.
 */
@Module({})
export class ProjectCustomFieldsModule {
  static register(): DynamicModule {
    const repository: Provider = {
      provide: PROJECT_CUSTOM_FIELDS_REPOSITORY,
      useFactory: () => new ProjectCustomFieldsRepository(),
    };
    const service: Provider = {
      provide: PROJECT_CUSTOM_FIELDS_SERVICE,
      inject: [TENANT_DATABASE, PROJECT_CUSTOM_FIELDS_REPOSITORY],
      useFactory: (database: TenantDatabase, fields: ProjectCustomFieldsRepository) =>
        new ProjectCustomFieldsService(database, fields, new ProjectsRepository()),
    };

    return {
      module: ProjectCustomFieldsModule,
      providers: [repository, service],
      exports: [service],
      controllers: [ProjectCustomFieldDefinitionsController, ProjectCustomFieldValuesController],
    };
  }
}

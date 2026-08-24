import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import {
  PROJECTS_REPOSITORY,
  PROJECTS_SERVICE,
  TENANT_DATABASE,
} from '../../common/http/tokens.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { ProjectsRepository } from './projects.repository.js';
import { ProjectsService } from './projects.service.js';
import { ProjectsController } from './projects.controller.js';

@Module({})
export class ProjectsModule {
  static register(): DynamicModule {
    const repository: Provider = {
      provide: PROJECTS_REPOSITORY,
      useFactory: () => new ProjectsRepository(),
    };
    const service: Provider = {
      provide: PROJECTS_SERVICE,
      inject: [TENANT_DATABASE, PROJECTS_REPOSITORY],
      useFactory: (database: TenantDatabase, projects: ProjectsRepository) =>
        new ProjectsService(database, projects),
    };

    return {
      module: ProjectsModule,
      providers: [repository, service],
      exports: [service],
      controllers: [ProjectsController],
    };
  }
}

import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import {
  AUDIT_SERVICE,
  PROJECTS_REPOSITORY,
  PROJECTS_SERVICE,
  PROJECT_MEMBERSHIPS_REPOSITORY,
  PROJECT_MEMBERSHIPS_SERVICE,
  TENANT_DATABASE,
} from '../../common/http/tokens.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { ProjectsRepository } from './projects.repository.js';
import { ProjectsService } from './projects.service.js';
import { ProjectsController } from './projects.controller.js';
import { ProjectMembershipsRepository } from './project-memberships.repository.js';
import { ProjectMembershipsService } from './project-memberships.service.js';
import type { AuditService } from '../audit/audit.service.js';

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

    const membershipsRepository: Provider = {
      provide: PROJECT_MEMBERSHIPS_REPOSITORY,
      useFactory: () => new ProjectMembershipsRepository(),
    };
    // No controller yet — the routes that expose these commands are not scheduled. The
    // service is wired anyway so that the audit path it establishes is exercised by the
    // database suite rather than only by the code that will one day call it.
    const membershipsService: Provider = {
      provide: PROJECT_MEMBERSHIPS_SERVICE,
      inject: [TENANT_DATABASE, AUDIT_SERVICE, PROJECT_MEMBERSHIPS_REPOSITORY],
      useFactory: (
        database: TenantDatabase,
        audit: AuditService,
        memberships: ProjectMembershipsRepository,
      ) => new ProjectMembershipsService(database, audit, memberships),
    };

    return {
      module: ProjectsModule,
      providers: [repository, service, membershipsRepository, membershipsService],
      exports: [service, membershipsService],
      controllers: [ProjectsController],
    };
  }
}

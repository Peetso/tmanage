import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import {
  AUDIT_SERVICE,
  MEMBERSHIPS_REPOSITORY,
  OUTBOX_EVENTS_REPOSITORY,
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
import { ProjectMembersController } from './project-members.controller.js';
import { ProjectMembershipsRepository } from './project-memberships.repository.js';
import { ProjectMembershipsService } from './project-memberships.service.js';
import { MembershipsRepository } from '../tenancy/memberships.repository.js';
import type { AuditService } from '../audit/audit.service.js';
import type { OutboxEventsRepository } from '../platform/outbox-events.repository.js';
import { SuggestDueController } from './suggest-due.controller.js';
import { SuggestDueService } from './suggest-due.service.js';
import { ProjectExportController } from './project-export.controller.js';
import { ProjectExportService } from './project-export.service.js';

@Module({})
export class ProjectsModule {
  static register(): DynamicModule {
    const repository: Provider = {
      provide: PROJECTS_REPOSITORY,
      useFactory: () => new ProjectsRepository(),
    };
    const service: Provider = {
      provide: PROJECTS_SERVICE,
      inject: [TENANT_DATABASE, PROJECTS_REPOSITORY, AUDIT_SERVICE],
      useFactory: (database: TenantDatabase, projects: ProjectsRepository, audit: AuditService) =>
        new ProjectsService(database, projects, audit),
    };

    const membershipsRepository: Provider = {
      provide: PROJECT_MEMBERSHIPS_REPOSITORY,
      useFactory: () => new ProjectMembershipsRepository(),
    };
    // ADM-02 (x116): `ProjectMembersController` reads the member directory to resolve a target
    // user inside the tenant before adding them. A repository is a stateless collection of
    // queries with no injected dependencies, constructed here for the reason `TenancyModule`
    // gives — reaching for another module's provider would mean registering it twice.
    const directoryRepository: Provider = {
      provide: MEMBERSHIPS_REPOSITORY,
      useFactory: () => new MembershipsRepository(),
    };
    // ADM-02 (x116) exposes these commands over HTTP through `ProjectMembersController`. The
    // service is also wired for the audit path exercised by the database suite.
    const membershipsService: Provider = {
      provide: PROJECT_MEMBERSHIPS_SERVICE,
      inject: [
        TENANT_DATABASE,
        AUDIT_SERVICE,
        PROJECT_MEMBERSHIPS_REPOSITORY,
        OUTBOX_EVENTS_REPOSITORY,
      ],
      useFactory: (
        database: TenantDatabase,
        audit: AuditService,
        memberships: ProjectMembershipsRepository,
        outbox: OutboxEventsRepository,
      ) => new ProjectMembershipsService(database, audit, memberships, outbox),
    };

    // 55-07 (R18-d): the due-date suggestion — stateless repositories, the tenant database.
    const suggestDueService: Provider = {
      provide: SuggestDueService,
      inject: [TENANT_DATABASE],
      useFactory: (database: TenantDatabase) => new SuggestDueService(database),
    };

    // 54-29: the per-project export — stateless repositories, the tenant database, the audit writer.
    const exportService: Provider = {
      provide: ProjectExportService,
      inject: [TENANT_DATABASE, AUDIT_SERVICE],
      useFactory: (database: TenantDatabase, audit: AuditService) =>
        new ProjectExportService(database, audit),
    };

    return {
      module: ProjectsModule,
      providers: [
        repository,
        service,
        membershipsRepository,
        directoryRepository,
        membershipsService,
        suggestDueService,
        exportService,
      ],
      exports: [service, membershipsService],
      controllers: [
        ProjectsController,
        ProjectMembersController,
        SuggestDueController,
        ProjectExportController,
      ],
    };
  }
}

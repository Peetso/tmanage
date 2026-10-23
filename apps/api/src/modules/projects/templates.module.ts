import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import {
  AUDIT_SERVICE,
  PROJECT_TEMPLATES_REPOSITORY,
  PROJECT_TEMPLATES_SERVICE,
  TENANT_DATABASE,
} from '../../common/http/tokens.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import type { AuditService } from '../audit/audit.service.js';
import { ProjectTemplatesRepository } from './templates.repository.js';
import { ProjectTemplatesService } from './templates.service.js';
import { ProjectTemplatesController } from './templates.controller.js';
import { ProjectsRepository } from './projects.repository.js';
import { ProjectsService } from './projects.service.js';

/**
 * PROJ / module 8 (x234). Reusable project templates — define, list, and instantiate a project from a
 * template.
 *
 * Same shape as `ProjectObjectivesModule`: a stateless repository under its token, a service that takes
 * the tenant database and the repository. The service also takes the **shared** `ProjectsService` so
 * `instantiate` delegates to the one project-create path rather than writing a second create. That
 * service is constructed here from the `@Global` `TENANT_DATABASE` and `AUDIT_SERVICE` and a fresh
 * stateless `ProjectsRepository` — the same construction `ProjectsModule` performs — so a
 * template-made project carries the same audit row and invariants as any other, and no module has to
 * be imported to reach it.
 */
@Module({})
export class ProjectTemplatesModule {
  static register(): DynamicModule {
    const repository: Provider = {
      provide: PROJECT_TEMPLATES_REPOSITORY,
      useFactory: () => new ProjectTemplatesRepository(),
    };
    const service: Provider = {
      provide: PROJECT_TEMPLATES_SERVICE,
      inject: [TENANT_DATABASE, PROJECT_TEMPLATES_REPOSITORY, AUDIT_SERVICE],
      useFactory: (
        database: TenantDatabase,
        templates: ProjectTemplatesRepository,
        audit: AuditService,
      ) =>
        new ProjectTemplatesService(
          database,
          templates,
          new ProjectsService(database, new ProjectsRepository(), audit),
          audit,
        ),
    };

    return {
      module: ProjectTemplatesModule,
      providers: [repository, service],
      exports: [service],
      controllers: [ProjectTemplatesController],
    };
  }
}

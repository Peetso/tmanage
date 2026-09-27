import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import {
  PROJECT_RISK_REGISTER_REPOSITORY,
  PROJECT_RISK_REGISTER_SERVICE,
  TENANT_DATABASE,
} from '../../common/http/tokens.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { ProjectRiskRegisterRepository } from './risk-register.repository.js';
import { ProjectRiskRegisterService } from './risk-register.service.js';
import { ProjectRiskRegisterController } from './risk-register.controller.js';
import { ProjectsRepository } from './projects.repository.js';

/**
 * PROJ / module 8 (x209). The internal risk-register module — a project's internal risks (log, list,
 * update, with a computed likelihood×impact severity).
 *
 * Same shape as `ProjectObjectivesModule`: a stateless repository under its token, a service that
 * takes the tenant database and the repository, and one controller. The service takes one more
 * read-only, stateless `ProjectsRepository` to resolve a named project inside the tenant before a
 * write (so an unknown or cross-tenant `projectId` is a 404, not a foreign-key 500).
 */
@Module({})
export class ProjectRiskRegisterModule {
  static register(): DynamicModule {
    const repository: Provider = {
      provide: PROJECT_RISK_REGISTER_REPOSITORY,
      useFactory: () => new ProjectRiskRegisterRepository(),
    };
    const service: Provider = {
      provide: PROJECT_RISK_REGISTER_SERVICE,
      inject: [TENANT_DATABASE, PROJECT_RISK_REGISTER_REPOSITORY],
      useFactory: (database: TenantDatabase, risks: ProjectRiskRegisterRepository) =>
        new ProjectRiskRegisterService(database, risks, new ProjectsRepository()),
    };

    return {
      module: ProjectRiskRegisterModule,
      providers: [repository, service],
      exports: [service],
      controllers: [ProjectRiskRegisterController],
    };
  }
}

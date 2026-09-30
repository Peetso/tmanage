import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import {
  PROJECT_BUDGET_REPOSITORY,
  PROJECT_BUDGET_SERVICE,
  TENANT_DATABASE,
} from '../../common/http/tokens.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { ProjectBudgetRepository } from './budget.repository.js';
import { ProjectBudgetService } from './budget.service.js';
import { ProjectBudgetController } from './budget.controller.js';
import { ProjectsRepository } from './projects.repository.js';

/**
 * PROJ / project detail (x293). The project-budget module — set a project's budget and read a
 * budget-vs-tracked summary.
 *
 * Same shape as `ProjectRiskRegisterModule`: a stateless repository under its token, a service that
 * takes the tenant database and the repository, and one controller. The service takes one more
 * read-only, stateless `ProjectsRepository` to resolve a named project inside the tenant before it
 * reads or writes (so an unknown or cross-tenant `projectId` is a 404, not a foreign-key 500).
 */
@Module({})
export class ProjectBudgetModule {
  static register(): DynamicModule {
    const repository: Provider = {
      provide: PROJECT_BUDGET_REPOSITORY,
      useFactory: () => new ProjectBudgetRepository(),
    };
    const service: Provider = {
      provide: PROJECT_BUDGET_SERVICE,
      inject: [TENANT_DATABASE, PROJECT_BUDGET_REPOSITORY],
      useFactory: (database: TenantDatabase, budgets: ProjectBudgetRepository) =>
        new ProjectBudgetService(database, budgets, new ProjectsRepository()),
    };

    return {
      module: ProjectBudgetModule,
      providers: [repository, service],
      exports: [service],
      controllers: [ProjectBudgetController],
    };
  }
}

import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import {
  AUDIT_SERVICE,
  PROJECT_BUDGET_REPOSITORY,
  PROJECT_BUDGET_SERVICE,
  TENANT_DATABASE,
} from '../../common/http/tokens.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import type { AuditService } from '../audit/audit.service.js';
import { ProjectBudgetRepository } from './budget.repository.js';
import { ProjectBudgetService } from './budget.service.js';
import { ProjectBudgetController } from './budget.controller.js';
import { ProjectsRepository } from './projects.repository.js';
import { BudgetBurnRepository } from './budget-burn.repository.js';
import { BUDGET_BURN_SERVICE, BudgetBurnService } from './budget-burn.service.js';
import { PortalBudgetController } from '../portal/portal-budget.controller.js';

/**
 * PROJ / project detail (x293). The project-budget module — set a project's budget and read a
 * budget-vs-tracked summary.
 *
 * Same shape as `ProjectRiskRegisterModule`: a stateless repository under its token, a service that
 * takes the tenant database and the repository, and one controller. The service takes one more
 * read-only, stateless `ProjectsRepository` to resolve a named project inside the tenant before it
 * reads or writes (so an unknown or cross-tenant `projectId` is a 404, not a foreign-key 500).
 *
 * 52-05 (R16-b): the burn service (burn report, portfolio column, portal projection) under
 * {@link BUDGET_BURN_SERVICE}, exported for the portfolio; the portal budget projection's
 * controller is registered here beside the service it reads. 52-07 expenses wire their
 * `BurnSources` later; until then the default adds nothing.
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
      inject: [TENANT_DATABASE, PROJECT_BUDGET_REPOSITORY, AUDIT_SERVICE],
      useFactory: (
        database: TenantDatabase,
        budgets: ProjectBudgetRepository,
        audit: AuditService,
      ) =>
        new ProjectBudgetService(database, budgets, new ProjectsRepository(), {
          audit,
          burn: new BudgetBurnRepository(),
        }),
    };
    const burn: Provider = {
      provide: BUDGET_BURN_SERVICE,
      inject: [TENANT_DATABASE],
      useFactory: (database: TenantDatabase) => new BudgetBurnService(database),
    };

    return {
      module: ProjectBudgetModule,
      providers: [repository, service, burn],
      exports: [service, burn],
      controllers: [ProjectBudgetController, PortalBudgetController],
    };
  }
}

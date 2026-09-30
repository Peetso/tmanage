import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import { APPROVALS_SERVICE, TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { ApprovalsRepository } from './approvals.repository.js';
import { DeliverableVersionsRepository } from './deliverable-versions.repository.js';
import { ClientProjectionsRepository } from './client-projections.repository.js';
import { ApprovalsService } from './approvals.service.js';
import { ApprovalsController } from './approvals.controller.js';
import { ApprovalDelegationRepository } from './delegation.repository.js';
import { ApprovalDelegationService } from './delegation.service.js';
import {
  APPROVAL_DELEGATION_SERVICE,
  ApprovalDelegationController,
} from './delegation.controller.js';
import { ApprovalStepsRepository } from './steps.repository.js';
import { APPROVAL_STEPS_SERVICE, ApprovalStepsService } from './steps.service.js';
import { ApprovalStepsController } from './steps.controller.js';

/**
 * FR-05's wiring.
 *
 * The two repositories are constructed in the factory rather than provided under their own tokens,
 * the choice `RequestsModule` documents: a repository is a stateless collection of scoped queries
 * with no injected dependencies, so a private instance costs nothing and keeps this module's
 * dependency surface to the one thing it genuinely shares — the tenant database.
 */
@Module({})
export class ApprovalsModule {
  static register(): DynamicModule {
    const service: Provider = {
      provide: APPROVALS_SERVICE,
      inject: [TENANT_DATABASE],
      useFactory: (database: TenantDatabase) =>
        new ApprovalsService(
          database,
          new ApprovalsRepository(),
          new DeliverableVersionsRepository(),
          new ClientProjectionsRepository(),
        ),
    };

    // x300 approval delegation — its own service, controllers registered here so the slice touches no
    // file another approvals slice appends to beyond this module. The delegator is the acting
    // membership; the delegate is resolved tenant-scoped in the service.
    const delegationService: Provider = {
      provide: APPROVAL_DELEGATION_SERVICE,
      inject: [TENANT_DATABASE],
      useFactory: (database: TenantDatabase) =>
        new ApprovalDelegationService(database, new ApprovalDelegationRepository()),
    };

    // x315 — sequential approval steps. Its own service and repository, constructed in the factory
    // like the approvals repositories above, sharing the one tenant database. Its controller mounts
    // beside the approvals surface under `/approvals/:approvalId/steps`.
    const stepsService: Provider = {
      provide: APPROVAL_STEPS_SERVICE,
      inject: [TENANT_DATABASE],
      useFactory: (database: TenantDatabase) =>
        new ApprovalStepsService(
          database,
          new ApprovalsRepository(),
          new ApprovalStepsRepository(),
        ),
    };

    return {
      module: ApprovalsModule,
      providers: [service, delegationService, stepsService],
      exports: [service, stepsService],
      controllers: [ApprovalsController, ApprovalDelegationController, ApprovalStepsController],
    };
  }
}

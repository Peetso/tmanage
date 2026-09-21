import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import { APPROVALS_SERVICE, TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { ApprovalsRepository } from './approvals.repository.js';
import { DeliverableVersionsRepository } from './deliverable-versions.repository.js';
import { ClientProjectionsRepository } from './client-projections.repository.js';
import { ApprovalsService } from './approvals.service.js';
import { ApprovalsController } from './approvals.controller.js';

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

    return {
      module: ApprovalsModule,
      providers: [service],
      exports: [service],
      controllers: [ApprovalsController],
    };
  }
}

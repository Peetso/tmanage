import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import {
  INVOICES_REPOSITORY,
  INVOICES_SERVICE,
  TENANT_DATABASE,
} from '../../common/http/tokens.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { InvoicesRepository } from './invoices.repository.js';
import { InvoicesService, InvoicesController } from './invoices.controller.js';

/**
 * FEAT: Billing invoice history (x179). The invoices module — the read-only invoice list and detail.
 *
 * A module of its own (`invoices.module.ts`) rather than another controller on the billing
 * subscription module, so it stays file-disjoint from the sibling billing slices. Same shape as the
 * read-only sibling modules: a stateless repository under its token and a service that takes the
 * tenant database and the repository, behind one controller.
 */
@Module({})
export class InvoicesModule {
  static register(): DynamicModule {
    const repository: Provider = {
      provide: INVOICES_REPOSITORY,
      useFactory: () => new InvoicesRepository(),
    };
    const service: Provider = {
      provide: INVOICES_SERVICE,
      inject: [TENANT_DATABASE, INVOICES_REPOSITORY],
      useFactory: (database: TenantDatabase, invoices: InvoicesRepository) =>
        new InvoicesService(database, invoices),
    };

    return {
      module: InvoicesModule,
      providers: [repository, service],
      exports: [service],
      controllers: [InvoicesController],
    };
  }
}

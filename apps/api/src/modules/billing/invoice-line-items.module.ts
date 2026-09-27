import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import {
  INVOICE_LINE_ITEMS_REPOSITORY,
  INVOICE_LINE_ITEMS_SERVICE,
  TENANT_DATABASE,
} from '../../common/http/tokens.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { InvoiceLineItemsRepository } from './invoice-line-items.repository.js';
import {
  InvoiceLineItemsService,
  InvoiceLineItemsController,
} from './invoice-line-items.controller.js';
import { InvoicesRepository } from './invoices.repository.js';

/**
 * FEAT: Billing invoice line items (x225). The invoice line-items module — the read-only per-invoice
 * line breakdown.
 *
 * A module of its own rather than another controller on the invoices module, so it stays
 * file-disjoint from the x179 slice. Same shape as the read-only sibling modules: a stateless
 * repository under its token and a service that takes the tenant database, the (stateless) invoices
 * repository it resolves the header with, and its own line repository, behind one controller.
 */
@Module({})
export class InvoiceLineItemsModule {
  static register(): DynamicModule {
    const repository: Provider = {
      provide: INVOICE_LINE_ITEMS_REPOSITORY,
      useFactory: () => new InvoiceLineItemsRepository(),
    };
    const service: Provider = {
      provide: INVOICE_LINE_ITEMS_SERVICE,
      inject: [TENANT_DATABASE, INVOICE_LINE_ITEMS_REPOSITORY],
      useFactory: (database: TenantDatabase, lines: InvoiceLineItemsRepository) =>
        new InvoiceLineItemsService(database, new InvoicesRepository(), lines),
    };

    return {
      module: InvoiceLineItemsModule,
      providers: [repository, service],
      exports: [service],
      controllers: [InvoiceLineItemsController],
    };
  }
}

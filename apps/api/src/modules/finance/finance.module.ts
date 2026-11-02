import { Global, Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { AUDIT_SERVICE, TENANT_DATABASE } from '../../common/http/tokens.js';
import type { AuditService } from '../audit/audit.service.js';
import { NotificationsRepository } from '../inbox/notifications.repository.js';
import { DocumentSequenceService } from './document-sequences.js';
import { EXPENSES_SERVICE, ExpensesController } from './expenses.controller.js';
import { ExpensesRepository } from './expenses.repository.js';
import { ExpensesService } from './expenses.service.js';
import { FINANCE_SERVICE, FinanceController } from './finance.controller.js';
import { FinanceRepository } from './finance.repository.js';
import { FinanceService } from './finance.service.js';
import { RATES_SERVICE, RatesController } from './rates.controller.js';
import { RatesRepository } from './rates.repository.js';
import { RatesService } from './rates.service.js';
import { RETAINERS_SERVICE, RetainersController } from './retainers.controller.js';
import { RetainersRepository } from './retainers.repository.js';
import { RetainersService } from './retainers.service.js';
import { PortalRetainersController } from '../portal/portal-retainers.controller.js';

/** The gapless numbering service, for the money items that issue documents (52-09, credit notes). */
export const DOCUMENT_SEQUENCES = Symbol.for('tmanage.DocumentSequenceService');

/**
 * 52-23 wiring. Global so a later issuing module (invoices) can inject {@link DOCUMENT_SEQUENCES}
 * and call `nextNumber(tx, organizationId, kind, issuedAt)` inside its own transaction.
 */
@Global()
@Module({})
export class FinanceModule {
  static register(): DynamicModule {
    const repository = new FinanceRepository();
    const service: Provider = {
      provide: FINANCE_SERVICE,
      inject: [TENANT_DATABASE, AUDIT_SERVICE],
      useFactory: (database: TenantDatabase, audit: AuditService) =>
        new FinanceService({ database, repository, audit }),
    };
    const sequences: Provider = {
      provide: DOCUMENT_SEQUENCES,
      useFactory: () => new DocumentSequenceService(repository),
    };
    // 52-04 rate cards, cost rates, resolver, re-price (R15-a).
    const rates: Provider = {
      provide: RATES_SERVICE,
      inject: [TENANT_DATABASE, AUDIT_SERVICE],
      useFactory: (database: TenantDatabase, audit: AuditService) =>
        new RatesService({ database, repository: new RatesRepository(), audit }),
    };
    // 52-07 expenses (R16-c).
    const expenses: Provider = {
      provide: EXPENSES_SERVICE,
      inject: [TENANT_DATABASE, AUDIT_SERVICE],
      useFactory: (database: TenantDatabase, audit: AuditService) =>
        new ExpensesService({
          database,
          repository: new ExpensesRepository(),
          finance: repository,
          rates: new RatesRepository(),
          notifications: new NotificationsRepository(),
          audit,
        }),
    };
    // 52-06 retainers (R17-d); the portal projection's controller sits beside the service it reads.
    const retainers: Provider = {
      provide: RETAINERS_SERVICE,
      inject: [TENANT_DATABASE, AUDIT_SERVICE],
      useFactory: (database: TenantDatabase, audit: AuditService) =>
        new RetainersService({
          database,
          repository: new RetainersRepository(),
          finance: repository,
          audit,
        }),
    };
    return {
      module: FinanceModule,
      providers: [service, sequences, rates, expenses, retainers],
      controllers: [
        FinanceController,
        RatesController,
        ExpensesController,
        RetainersController,
        PortalRetainersController,
      ],
      exports: [DOCUMENT_SEQUENCES],
    };
  }
}

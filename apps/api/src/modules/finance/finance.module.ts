import { Global, Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { AUDIT_SERVICE, TENANT_DATABASE } from '../../common/http/tokens.js';
import type { AuditService } from '../audit/audit.service.js';
import { DocumentSequenceService } from './document-sequences.js';
import { FINANCE_SERVICE, FinanceController } from './finance.controller.js';
import { FinanceRepository } from './finance.repository.js';
import { FinanceService } from './finance.service.js';

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
    return {
      module: FinanceModule,
      providers: [service, sequences],
      controllers: [FinanceController],
      exports: [DOCUMENT_SEQUENCES],
    };
  }
}

import { Global, Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { API_CONFIG, AUDIT_SERVICE, MAILER, TENANT_DATABASE } from '../../common/http/tokens.js';
import type { ApiConfig } from '../../common/http/api-config.js';
import type { Mailer } from '@tmanage/mail';
import type { AuditService } from '../audit/audit.service.js';
import { NotificationsRepository } from '../inbox/notifications.repository.js';
import { OutboxEventsRepository } from '../platform/outbox-events.repository.js';
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
import { PortalInvoicesController } from '../portal/portal-invoices.controller.js';
import { CLIENT_INVOICES_SERVICE, ClientInvoicesController } from './client-invoices.controller.js';
import { ClientInvoicesRepository } from './client-invoices.repository.js';
import { ClientInvoicesService } from './client-invoices.service.js';
import { FINANCE_EXPORTS_SERVICE, FinanceExportsController } from './finance-exports.controller.js';
import { FinanceExportsRepository } from './finance-exports.repository.js';
import { FinanceExportsService } from './finance-exports.service.js';
import { EinvoiceSigningService } from './einvoice-signing.service.js';
import {
  EINVOICE_SIGNING_SERVICE,
  EinvoicingCertificateController,
} from './einvoicing-certificate.controller.js';
import { OrgBrandingRepository } from '../admin/org-branding.repository.js';
import { OrgSecretsRepository } from './org-secrets.repository.js';
import { EinvoiceChainController } from './einvoice-chain.controller.js';

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
    // R22-a · 52-12 the ZATCA signing certificate (org_secrets) and the one decrypting signer.
    const signing: Provider = {
      provide: EINVOICE_SIGNING_SERVICE,
      inject: [TENANT_DATABASE, AUDIT_SERVICE, { token: API_CONFIG, optional: true }],
      useFactory: (database: TenantDatabase, audit: AuditService, config: ApiConfig | undefined) =>
        new EinvoiceSigningService({
          database,
          repository: new OrgSecretsRepository(),
          audit,
          ...(config?.sessionSecret === undefined ? {} : { sessionSecret: config.sessionSecret }),
        }),
    };
    // 52-09 client invoices (R18-a); the portal projection's controller sits beside the service.
    const clientInvoices: Provider = {
      provide: CLIENT_INVOICES_SERVICE,
      inject: [
        TENANT_DATABASE,
        AUDIT_SERVICE,
        EINVOICE_SIGNING_SERVICE,
        { token: MAILER, optional: true },
        { token: API_CONFIG, optional: true },
      ],
      useFactory: (
        database: TenantDatabase,
        audit: AuditService,
        signer: EinvoiceSigningService,
        mailer: Mailer | null | undefined,
        config: ApiConfig | undefined,
      ) =>
        new ClientInvoicesService({
          signing: signer,
          signingStore: new OrgSecretsRepository(),
          outbox: new OutboxEventsRepository(),
          database,
          repository: new ClientInvoicesRepository(),
          finance: repository,
          sequences: new DocumentSequenceService(repository),
          notifications: new NotificationsRepository(),
          audit,
          mailer: mailer ?? null,
          branding: new OrgBrandingRepository(),
          ...(config?.webPublicUrl === undefined ? {} : { webPublicUrl: config.webPublicUrl }),
          ...(config?.sessionSecret === undefined ? {} : { sessionSecret: config.sessionSecret }),
        }),
    };
    // 52-11 accounting export by file (R19-b); step-up uses the session secret like invoice.send.
    const financeExports: Provider = {
      provide: FINANCE_EXPORTS_SERVICE,
      inject: [TENANT_DATABASE, AUDIT_SERVICE, { token: API_CONFIG, optional: true }],
      useFactory: (database: TenantDatabase, audit: AuditService, config: ApiConfig | undefined) =>
        new FinanceExportsService({
          database,
          repository: new FinanceExportsRepository(),
          audit,
          ...(config?.sessionSecret === undefined ? {} : { sessionSecret: config.sessionSecret }),
        }),
    };
    return {
      module: FinanceModule,
      providers: [
        service,
        sequences,
        rates,
        expenses,
        retainers,
        signing,
        clientInvoices,
        financeExports,
      ],
      controllers: [
        FinanceController,
        RatesController,
        ExpensesController,
        RetainersController,
        PortalRetainersController,
        ClientInvoicesController,
        PortalInvoicesController,
        FinanceExportsController,
        // R22-a · 52-12 the ZATCA signing certificate.
        EinvoicingCertificateController,
        // R22-b · 52-12 the e-invoice chain verdict (worker-written, read-only here).
        EinvoiceChainController,
      ],
      exports: [DOCUMENT_SEQUENCES],
    };
  }
}

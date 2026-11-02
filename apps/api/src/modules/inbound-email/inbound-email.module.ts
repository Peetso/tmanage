import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import type { ObjectStore } from '@tmanage/storage';
import type { Mailer } from '@tmanage/mail';
import {
  AUDIT_SERVICE,
  MAILER,
  MALWARE_SCANNER,
  OBJECT_STORE,
  OUTBOX_EVENTS_REPOSITORY,
  TENANT_DATABASE,
} from '../../common/http/tokens.js';
import { NoneScanner } from '../../common/scan/malware-scanner.js';
import type { MalwareScanner } from '../../common/scan/malware-scanner.js';
import { fileScanJobEnabled } from '../files/file-scan-job.js';
import { InboundAttachmentsRepository } from './inbound-attachments.repository.js';
import { InboundAttachmentsService } from './inbound-attachments.service.js';
import { InboundAttachmentsController } from './inbound-attachments.controller.js';
import { runInboundAttachmentPass } from './inbound-attachment-scan.js';
import {
  INBOUND_ATTACHMENT_SCAN_JOB,
  InboundAttachmentScanJob,
} from './inbound-attachment-scan.job.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import type { AuditService } from '../audit/audit.service.js';
import type { OutboxEventsRepository } from '../platform/outbox-events.repository.js';
import { ProjectsRepository } from '../projects/projects.repository.js';
import { WorkItemsRepository } from '../work/work-items.repository.js';
import { WorkItemsService } from '../work/work-items.service.js';
import { InboundEmailRepository } from './inbound-email.repository.js';
import { InboundEmailService } from './inbound-email.service.js';
import { InboundEmailController } from './inbound-email.controller.js';
import {
  InboundWebhookBodyCapture,
  InboundWebhookController,
} from './inbound-webhook.controller.js';

/**
 * R21-f (54-12 / 54-12a) — inbound e-mail wiring. The service is exported so the later poller can
 * call `ingest()`; no poller is registered here.
 *
 * R22-c (hunk 1): the JSON webhook controller and its raw-body capture; the service builds its own
 * `WorkItemsService` (the public-forms precedent: the one work-create path, no coupling to
 * `WorkModule`'s exports) for the member -> work item outcome, and takes the global `OBJECT_STORE`
 * (optional: without it a passing mail's attachments are recorded `unavailable`).
 */
@Module({})
export class InboundEmailModule {
  static register(): DynamicModule {
    const service: Provider = {
      provide: InboundEmailService,
      inject: [
        TENANT_DATABASE,
        AUDIT_SERVICE,
        OUTBOX_EVENTS_REPOSITORY,
        { token: OBJECT_STORE, optional: true },
      ],
      useFactory: (
        database: TenantDatabase,
        audit: AuditService,
        outbox: OutboxEventsRepository,
        store: ObjectStore | undefined,
      ) =>
        new InboundEmailService(database, new InboundEmailRepository(), {
          workItems: new WorkItemsService(
            database,
            new WorkItemsRepository(),
            audit,
            new ProjectsRepository(),
            outbox,
          ),
          ...(store !== undefined ? { store } : {}),
        }),
    };
    // R22-d (hunk 2): preview/download/ask-resend, and the in-process attachment scan pass (the
    // file-scan-job switch; without a store or with the `none` scanner nothing becomes clean).
    const attachments: Provider = {
      provide: InboundAttachmentsService,
      inject: [
        TENANT_DATABASE,
        AUDIT_SERVICE,
        { token: OBJECT_STORE, optional: true },
        { token: MAILER, optional: true },
      ],
      useFactory: (
        database: TenantDatabase,
        audit: AuditService,
        store: ObjectStore | undefined,
        mailer: Mailer | undefined,
      ) =>
        new InboundAttachmentsService(
          database,
          new InboundAttachmentsRepository(),
          new InboundEmailRepository(),
          store ?? null,
          audit,
          mailer ?? null,
        ),
    };
    const scanJob: Provider = {
      provide: INBOUND_ATTACHMENT_SCAN_JOB,
      inject: [
        TENANT_DATABASE,
        AUDIT_SERVICE,
        OUTBOX_EVENTS_REPOSITORY,
        { token: OBJECT_STORE, optional: true },
        { token: MALWARE_SCANNER, optional: true },
      ],
      useFactory: (
        database: TenantDatabase,
        audit: AuditService,
        outbox: OutboxEventsRepository,
        store: ObjectStore | undefined,
        scanner: MalwareScanner | undefined,
      ) => {
        const repository = new InboundAttachmentsRepository();
        return new InboundAttachmentScanJob(
          () =>
            runInboundAttachmentPass({
              database,
              // Without a store there is nothing to read: the `none` path claims nothing.
              store: store as ObjectStore,
              scanner: store !== undefined && scanner !== undefined ? scanner : new NoneScanner(),
              repository,
              audit,
              outbox,
            }),
          fileScanJobEnabled(),
        );
      },
    };
    return {
      module: InboundEmailModule,
      providers: [service, InboundWebhookBodyCapture, attachments, scanJob],
      controllers: [InboundEmailController, InboundWebhookController, InboundAttachmentsController],
      exports: [InboundEmailService],
    };
  }
}

import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import {
  API_CONFIG,
  AUDIT_SERVICE,
  MALWARE_SCANNER,
  OUTBOX_EVENTS_REPOSITORY,
  TENANT_DATABASE,
} from '../../common/http/tokens.js';
import type { ApiConfig } from '../../common/http/api-config.js';
import type { MalwareScanner } from '../../common/scan/malware-scanner.js';
import type { AuditService } from '../audit/audit.service.js';
import type { OutboxEventsRepository } from '../platform/outbox-events.repository.js';
import { ProjectsRepository } from '../projects/projects.repository.js';
import { WorkItemsRepository } from '../work/work-items.repository.js';
import { WorkItemsService } from '../work/work-items.service.js';
import { PUBLIC_ABUSE_ASSESS } from '../public-abuse/public-abuse.guard.js';
import type { AssessPublicWrite } from '../public-abuse/public-abuse.guard.js';
import { PublicFormAttachmentGate } from './public-form-attachments.js';
import {
  PUBLIC_FORM_ATTACHMENT_GATE,
  PUBLIC_FORMS_SERVICE,
  PublicFormsAdminController,
  PublicFormsController,
} from './public-forms.controller.js';
import { PublicFormsRepository } from './public-forms.repository.js';
import { PublicFormsService } from './public-forms.service.js';

/**
 * 52-20 wiring. Builds its own `WorkItemsService` (the inbox does the same) so conversion reuses
 * the one work-create path without coupling to `WorkModule`'s exports; takes 52-21's global
 * `PUBLIC_ABUSE_ASSESS` (optional: a composition without it stores every valid submission clear).
 */
@Module({})
export class PublicFormsModule {
  static register(): DynamicModule {
    // 52-20a. The attachment gate: the owner's setting, the scanner and the visit's draft token.
    const gate: Provider = {
      provide: PUBLIC_FORM_ATTACHMENT_GATE,
      inject: [TENANT_DATABASE, MALWARE_SCANNER, API_CONFIG],
      useFactory: (database: TenantDatabase, malwareScanner: MalwareScanner, config: ApiConfig) =>
        new PublicFormAttachmentGate(
          database,
          new PublicFormsRepository(),
          malwareScanner,
          config.sessionSecret,
        ),
    };
    const service: Provider = {
      provide: PUBLIC_FORMS_SERVICE,
      inject: [
        TENANT_DATABASE,
        AUDIT_SERVICE,
        OUTBOX_EVENTS_REPOSITORY,
        PUBLIC_FORM_ATTACHMENT_GATE,
        { token: PUBLIC_ABUSE_ASSESS, optional: true },
      ],
      useFactory: (
        database: TenantDatabase,
        audit: AuditService,
        outbox: OutboxEventsRepository,
        attachments: PublicFormAttachmentGate,
        assess: AssessPublicWrite | undefined,
      ) =>
        new PublicFormsService(
          database,
          new PublicFormsRepository(),
          new WorkItemsService(
            database,
            new WorkItemsRepository(),
            audit,
            new ProjectsRepository(),
            outbox,
          ),
          assess ?? null,
          attachments,
        ),
    };
    return {
      module: PublicFormsModule,
      providers: [gate, service],
      controllers: [PublicFormsAdminController, PublicFormsController],
    };
  }
}

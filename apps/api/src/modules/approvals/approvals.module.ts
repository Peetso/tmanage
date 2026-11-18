import { Inject, Injectable, Module, Optional } from '@nestjs/common';
import type { DynamicModule, OnModuleInit, Provider } from '@nestjs/common';
import type { Mailer } from '@tmanage/mail';
import type { ApiConfig } from '../../common/http/api-config.js';
import type { MalwareScanner } from '../../common/scan/malware-scanner.js';
import { ClientFileSharing } from '../files/client-file-sharing.js';
import {
  API_CONFIG,
  APPROVALS_SERVICE,
  AUDIT_SERVICE,
  MAILER,
  MALWARE_SCANNER,
  OBJECT_STORE,
  OUTBOX_EVENTS_REPOSITORY,
  TENANT_DATABASE,
} from '../../common/http/tokens.js';
import { PUBLIC_LINKS_SERVICE } from '../public-links/public-links.controller.js';
import { PUBLIC_LINK_TARGETS } from '../public-links/public-link-targets.js';
import type { PublicLinkTargets } from '../public-links/public-link-targets.js';
import { PublicLinksRepository } from '../public-links/public-links.repository.js';
import type { PublicLinksService } from '../public-links/public-links.service.js';
import type { OutboxEventsRepository } from '../platform/outbox-events.repository.js';
import type { AuditService } from '../audit/audit.service.js';
import { ProjectsRepository } from '../projects/projects.repository.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import type { ObjectStore } from '@tmanage/storage';
import { ApprovalsRepository } from './approvals.repository.js';
import { ApprovalRecordsRepository } from './approval-records.repository.js';
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
import { DeliverablesRepository } from './deliverables.repository.js';
import { DeliverablesService } from './deliverables.service.js';
import { DELIVERABLES_SERVICE, DeliverablesController } from './deliverables.controller.js';
import {
  EXTERNAL_APPROVALS_SERVICE,
  ExternalApprovalsController,
} from './external-approvals.controller.js';
import { ExternalApprovalsService } from './external-approvals.service.js';
import { ExternalApproversRepository } from './external-approvers.repository.js';
import {
  APPROVAL_CERTIFICATE_PDF_SERVICE,
  ApprovalCertificatePdfController,
} from './record-pdf.controller.js';
import { ApprovalCertificatePdfService, RecordPdfStore } from './record-pdf.service.js';
import {
  APPROVAL_EVIDENCE_SERVICE,
  ApprovalEvidenceController,
} from './approval-records-evidence.controller.js';
import { ApprovalEvidenceService } from './approval-records-evidence.service.js';
import { VersionStore } from '../files/provider-objects.js';
import { providerObjectSources } from '../files/provider-object-sources.js';

/**
 * 52-18 — at start-up, hook the external approver record onto the 56-07 `deliverable_version`
 * link target: the outsider's decision then records, notifies and audits in its own transaction.
 */
@Injectable()
class ExternalApprovalDecisionRegistrar implements OnModuleInit {
  constructor(
    @Optional()
    @Inject(PUBLIC_LINK_TARGETS)
    private readonly targets: PublicLinkTargets | undefined,
    @Inject(EXTERNAL_APPROVALS_SERVICE) private readonly service: ExternalApprovalsService,
  ) {}

  onModuleInit(): void {
    this.targets?.observeDecisions('deliverable_version', (tx, context, link, decision, detail) =>
      this.service.recordDecision(tx, context, link, decision, detail),
    );
  }
}

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
      // Q3: a decision appends `approval.decided.v1` and an audit row in its own transaction. Both
      // are global providers; the audit service is optional (the custom-roles posture).
      inject: [
        TENANT_DATABASE,
        OUTBOX_EVENTS_REPOSITORY,
        MALWARE_SCANNER,
        { token: AUDIT_SERVICE, optional: true },
      ],
      useFactory: (
        database: TenantDatabase,
        outbox: OutboxEventsRepository,
        scanner: MalwareScanner,
        audit?: AuditService,
      ) =>
        new ApprovalsService(
          database,
          new ApprovalsRepository(),
          new DeliverableVersionsRepository(),
          new ClientProjectionsRepository(),
          outbox,
          audit,
          // FIX6 item 1: a published version's file is shared by the one sharing rule.
          new ClientFileSharing(scanner),
          // 52-19: every reviewer decision seals an approval record in its own transaction.
          new ApprovalRecordsRepository(),
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

    // 0211 (audit gap 1) — deliverables: create, version, send for client approval. The outbox
    // writer is the global `PlatformModule`'s, so the send's `approval.requested.v1` commits with it.
    const deliverablesService: Provider = {
      provide: DELIVERABLES_SERVICE,
      inject: [
        TENANT_DATABASE,
        OUTBOX_EVENTS_REPOSITORY,
        MALWARE_SCANNER,
        { token: AUDIT_SERVICE, optional: true },
      ],
      useFactory: (
        database: TenantDatabase,
        outbox: OutboxEventsRepository,
        scanner: MalwareScanner,
        audit?: AuditService,
      ) =>
        new DeliverablesService(
          database,
          new DeliverablesRepository(),
          new DeliverableVersionsRepository(),
          new ApprovalsRepository(),
          new ClientProjectionsRepository(),
          new ProjectsRepository(),
          outbox,
          audit,
          // FIX6 item 1: the scanner, so a version's file is shared by the one sharing rule.
          new ClientFileSharing(scanner),
        ),
    };

    // 52-18 — the account-less approver: sends through the global 56-07 link service, mails the
    // `/a/<token>` link on the global mailer (optional: with none the sender copies the link).
    const externalApprovalsService: Provider = {
      provide: EXTERNAL_APPROVALS_SERVICE,
      inject: [
        TENANT_DATABASE,
        OUTBOX_EVENTS_REPOSITORY,
        PUBLIC_LINKS_SERVICE,
        API_CONFIG,
        { token: AUDIT_SERVICE, optional: true },
        { token: MAILER, optional: true },
      ],
      useFactory: (
        database: TenantDatabase,
        outbox: OutboxEventsRepository,
        links: PublicLinksService,
        config: ApiConfig,
        audit?: AuditService,
        mailer?: Mailer | null,
      ) => {
        const linkStore = new PublicLinksRepository();
        return new ExternalApprovalsService({
          database,
          approvers: new ExternalApproversRepository(),
          versions: new DeliverableVersionsRepository(),
          deliverables: new DeliverablesRepository(),
          links,
          outbox,
          audit: audit ?? null,
          mailer: mailer ?? null,
          organizationName: (tx, context) => linkStore.organizationName(tx, context),
          webPublicUrl: config.webPublicUrl ?? '',
        });
      },
    };

    // 52-19 — the approval certificate as a PDF: the certificate read above, rendered and stored
    // in the object store's derived zone.
    const certificatePdfService: Provider = {
      provide: APPROVAL_CERTIFICATE_PDF_SERVICE,
      inject: [TENANT_DATABASE, APPROVALS_SERVICE, OBJECT_STORE],
      useFactory: (database: TenantDatabase, approvals: ApprovalsService, store: ObjectStore) =>
        new ApprovalCertificatePdfService(database, approvals, new RecordPdfStore(store)),
    };

    // 52-19 — the evidence bundle: the certificate PDF above, the approved file (read where it is
    // held, Drive/OneDrive included) and the chain proof, audited on every download.
    const evidenceService: Provider = {
      provide: APPROVAL_EVIDENCE_SERVICE,
      inject: [
        TENANT_DATABASE,
        APPROVALS_SERVICE,
        APPROVAL_CERTIFICATE_PDF_SERVICE,
        OBJECT_STORE,
        AUDIT_SERVICE,
        API_CONFIG,
      ],
      useFactory: (
        database: TenantDatabase,
        approvals: ApprovalsService,
        pdfs: ApprovalCertificatePdfService,
        store: ObjectStore,
        audit: AuditService,
        config: ApiConfig,
      ) =>
        new ApprovalEvidenceService(
          database,
          approvals,
          pdfs,
          new VersionStore(store, providerObjectSources(database, audit, config)),
          audit,
        ),
    };

    return {
      module: ApprovalsModule,
      providers: [
        service,
        certificatePdfService,
        evidenceService,
        delegationService,
        stepsService,
        deliverablesService,
        externalApprovalsService,
        ExternalApprovalDecisionRegistrar,
      ],
      exports: [service, stepsService],
      controllers: [
        ApprovalsController,
        ApprovalDelegationController,
        ApprovalStepsController,
        DeliverablesController,
        ExternalApprovalsController,
        ApprovalCertificatePdfController,
        ApprovalEvidenceController,
      ],
    };
  }
}

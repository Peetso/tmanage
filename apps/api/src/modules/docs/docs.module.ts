import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import {
  AUDIT_SERVICE,
  DOCUMENTS_REPOSITORY,
  DOCUMENTS_SERVICE,
  DOCUMENT_COMMENTS_SERVICE,
  DOC_REVIEWS_SERVICE,
  OUTBOX_EVENTS_REPOSITORY,
  TENANT_DATABASE,
} from '../../common/http/tokens.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import type { OutboxEventsRepository } from '../platform/outbox-events.repository.js';
import type { AuditService } from '../audit/audit.service.js';
import { ProjectsRepository } from '../projects/projects.repository.js';
import { DocumentVersionsRepository } from './document-versions.repository.js';
import { DocumentTemplatesRepository } from './document-templates.repository.js';
import { DocumentsRepository } from './documents.repository.js';
import { DocumentCommentsRepository } from './document-comments.repository.js';
import { DocumentSharingRepository } from './document-sharing.repository.js';
import { DocumentsService } from './documents.service.js';
import { DocumentsController } from './documents.controller.js';
import { DocumentExportController } from './document-export.controller.js';
import { DocumentCommentsService } from './document-comments.service.js';
import { DocumentCommentsController } from './document-comments.controller.js';
import { DocumentPresenceService } from './document-presence.service.js';
import {
  DOCUMENT_PRESENCE_SERVICE,
  DocumentPresenceController,
} from './document-presence.controller.js';
import { DocLinksService } from './doc-links.service.js';
import {
  DOC_LINKS_SERVICE,
  DocBacklinksController,
  DocLinksController,
} from './doc-links.controller.js';
import { DocReadStateService } from './doc-read-state.service.js';
import {
  DOC_READ_STATE_SERVICE,
  DocumentReadStateController,
  MyDocReadStateController,
} from './doc-read-state.controller.js';
import { DocReviewsService } from './reviews.service.js';
import { DocReviewsController } from './reviews.controller.js';
import { DocumentSharingService } from './document-sharing.service.js';
import {
  DOCUMENT_SHARING_SERVICE,
  DocumentSharingController,
  RecentDocumentsController,
} from './document-sharing.controller.js';

/**
 * DOC-01 (x91). The docs module's first vertical slice: document read/write.
 *
 * Same shape as `ProjectsModule`/`CalendarModule` — a stateless repository under its token, a
 * service that takes the tenant database and the repository, and one controller. The service
 * needs no audit or outbox dependency this slice (see `DocumentsService`), so its `inject` list
 * is just the database and the repository.
 *
 * Docs "collaboration later" (x132) adds the document-comments controller/service beside it. The
 * comments service resolves the document tenant-scoped through its own `DocumentsRepository` (the
 * Known-trap order) and appends/lists through its `DocumentCommentsRepository`, both constructed with
 * their defaults, so it needs only the tenant database injected.
 */
@Module({})
export class DocsModule {
  static register(): DynamicModule {
    const repository: Provider = {
      provide: DOCUMENTS_REPOSITORY,
      useFactory: () => new DocumentsRepository(),
    };
    // B4: rename writes an audit row and a `document.renamed.v1` event, so the service now also
    // takes the (global) audit service and the outbox.
    const service: Provider = {
      provide: DOCUMENTS_SERVICE,
      inject: [
        TENANT_DATABASE,
        DOCUMENTS_REPOSITORY,
        { token: AUDIT_SERVICE, optional: true },
        OUTBOX_EVENTS_REPOSITORY,
      ],
      useFactory: (
        database: TenantDatabase,
        documents: DocumentsRepository,
        audit: AuditService | undefined,
        outbox: OutboxEventsRepository,
      ) =>
        new DocumentsService(
          database,
          documents,
          new ProjectsRepository(),
          new DocumentVersionsRepository(),
          new DocumentTemplatesRepository(),
          audit,
          outbox,
        ),
    };
    const commentsService: Provider = {
      provide: DOCUMENT_COMMENTS_SERVICE,
      inject: [TENANT_DATABASE, OUTBOX_EVENTS_REPOSITORY],
      useFactory: (database: TenantDatabase, outbox: OutboxEventsRepository) =>
        new DocumentCommentsService(
          database,
          new DocumentsRepository(),
          new DocumentCommentsRepository(),
          new DocumentSharingRepository(),
          outbox,
        ),
    };
    // DOC links + backlinks (x296): its own service resolves each document tenant-scoped through a
    // `DocumentsRepository` (the Known-trap order) and reads/writes through its `DocLinksRepository`,
    // both constructed with their defaults, so it needs only the tenant database injected.
    const docLinksService: Provider = {
      provide: DOC_LINKS_SERVICE,
      inject: [TENANT_DATABASE],
      useFactory: (database: TenantDatabase) => new DocLinksService(database),
    };
    // DOC read state (x297): a per-membership read cursor over documents. Its service resolves the
    // document tenant-scoped through its own `DocumentsRepository` (the Known-trap order) and
    // reads/writes through its `DocReadStateRepository`, both default-constructed, so it needs only
    // the tenant database injected.
    const readStateService: Provider = {
      provide: DOC_READ_STATE_SERVICE,
      inject: [TENANT_DATABASE],
      useFactory: (database: TenantDatabase) => new DocReadStateService(database),
    };
    // Docs review workflow (x313): a request/decide/list service resolving the document tenant-scoped
    // through its own `DocumentsRepository` (the Known-trap order), so it needs only the database.
    const reviewsService: Provider = {
      provide: DOC_REVIEWS_SERVICE,
      inject: [TENANT_DATABASE],
      useFactory: (database: TenantDatabase) => new DocReviewsService(database),
    };

    // Docs sharing (UI rebuild): Recent, audience/collaborators and publish. Default-constructed
    // repositories, so only the tenant database is injected.
    const sharingService: Provider = {
      provide: DOCUMENT_SHARING_SERVICE,
      inject: [TENANT_DATABASE, OUTBOX_EVENTS_REPOSITORY],
      useFactory: (database: TenantDatabase, outbox: OutboxEventsRepository) =>
        new DocumentSharingService(
          database,
          new DocumentsRepository(),
          new DocumentSharingRepository(),
          outbox,
        ),
    };

    // R5 slice 2: who is editing a document — in-memory, so the provider's singleton is the store.
    // It reads each document through the documents service (tenant-scoped, relation-checked).
    const presenceService: Provider = {
      provide: DOCUMENT_PRESENCE_SERVICE,
      inject: [TENANT_DATABASE, DOCUMENTS_SERVICE],
      useFactory: (database: TenantDatabase, documents: DocumentsService) =>
        new DocumentPresenceService(database, documents, new DocumentSharingRepository()),
    };

    return {
      module: DocsModule,
      providers: [
        repository,
        service,
        commentsService,
        docLinksService,
        readStateService,
        reviewsService,
        sharingService,
        presenceService,
      ],
      exports: [service, commentsService, reviewsService],
      // DOC export (x131): a second controller on the same `documents` base path, serving the
      // read-only Markdown download. It resolves the same `DOCUMENTS_SERVICE` this module provides.
      // DOC links + backlinks (x296): the outgoing-links and backlinks controllers.
      // DOC read state (x297) adds two controllers: the per-document read/unread toggle and the
      // caller's batch read-state.
      // DOC reviews (x313): the review request/decide/list controller.
      controllers: [
        DocumentsController,
        DocumentExportController,
        DocumentCommentsController,
        DocLinksController,
        DocBacklinksController,
        DocumentReadStateController,
        MyDocReadStateController,
        DocReviewsController,
        RecentDocumentsController,
        DocumentSharingController,
        DocumentPresenceController,
      ],
    };
  }
}

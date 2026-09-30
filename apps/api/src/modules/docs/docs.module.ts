import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import {
  DOCUMENTS_REPOSITORY,
  DOCUMENTS_SERVICE,
  DOCUMENT_COMMENTS_SERVICE,
  TENANT_DATABASE,
} from '../../common/http/tokens.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { DocumentsRepository } from './documents.repository.js';
import { DocumentsService } from './documents.service.js';
import { DocumentsController } from './documents.controller.js';
import { DocumentExportController } from './document-export.controller.js';
import { DocumentCommentsService } from './document-comments.service.js';
import { DocumentCommentsController } from './document-comments.controller.js';
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
    const service: Provider = {
      provide: DOCUMENTS_SERVICE,
      inject: [TENANT_DATABASE, DOCUMENTS_REPOSITORY],
      useFactory: (database: TenantDatabase, documents: DocumentsRepository) =>
        new DocumentsService(database, documents),
    };
    const commentsService: Provider = {
      provide: DOCUMENT_COMMENTS_SERVICE,
      inject: [TENANT_DATABASE],
      useFactory: (database: TenantDatabase) => new DocumentCommentsService(database),
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

    return {
      module: DocsModule,
      providers: [repository, service, commentsService, docLinksService, readStateService],
      exports: [service, commentsService],
      // DOC export (x131): a second controller on the same `documents` base path, serving the
      // read-only Markdown download. It resolves the same `DOCUMENTS_SERVICE` this module provides.
      // DOC links + backlinks (x296): the outgoing-links and backlinks controllers.
      // DOC read state (x297) adds two controllers: the per-document read/unread toggle and the
      // caller's batch read-state.
      controllers: [
        DocumentsController,
        DocumentExportController,
        DocumentCommentsController,
        DocLinksController,
        DocBacklinksController,
        DocumentReadStateController,
        MyDocReadStateController,
      ],
    };
  }
}

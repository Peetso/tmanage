import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import {
  DOCUMENTS_REPOSITORY,
  DOCUMENTS_SERVICE,
  DOCUMENT_COMMENTS_SERVICE,
  DOC_REVIEWS_SERVICE,
  TENANT_DATABASE,
} from '../../common/http/tokens.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { DocumentsRepository } from './documents.repository.js';
import { DocumentsService } from './documents.service.js';
import { DocumentsController } from './documents.controller.js';
import { DocumentExportController } from './document-export.controller.js';
import { DocumentCommentsService } from './document-comments.service.js';
import { DocumentCommentsController } from './document-comments.controller.js';
import { DocReviewsService } from './reviews.service.js';
import { DocReviewsController } from './reviews.controller.js';

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
    // Docs review workflow (x313): a request/decide/list service resolving the document tenant-scoped
    // through its own `DocumentsRepository` (the Known-trap order), so it needs only the database.
    const reviewsService: Provider = {
      provide: DOC_REVIEWS_SERVICE,
      inject: [TENANT_DATABASE],
      useFactory: (database: TenantDatabase) => new DocReviewsService(database),
    };

    return {
      module: DocsModule,
      providers: [repository, service, commentsService, reviewsService],
      exports: [service, commentsService, reviewsService],
      // DOC export (x131): a second controller on the same `documents` base path, serving the
      // read-only Markdown download. It resolves the same `DOCUMENTS_SERVICE` this module provides.
      controllers: [
        DocumentsController,
        DocumentExportController,
        DocumentCommentsController,
        DocReviewsController,
      ],
    };
  }
}

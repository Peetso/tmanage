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
import { DocumentCommentsService } from './document-comments.service.js';
import { DocumentCommentsController } from './document-comments.controller.js';

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

    return {
      module: DocsModule,
      providers: [repository, service, commentsService],
      exports: [service, commentsService],
      controllers: [DocumentsController, DocumentCommentsController],
    };
  }
}

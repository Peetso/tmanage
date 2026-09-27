import { Controller, Delete, Get, HttpCode, Inject, Module, Param, Put } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { DocBookmarksService } from './bookmarks.service.js';
import type { DocBookmarkView } from './bookmarks.service.js';

/**
 * DOC bookmarks / favorites (x242). Bookmark a document, unbookmark it, read the caller's bookmark
 * status of one document, and list the caller's bookmarks. Like every tenant-scoped controller here it
 * never reads `organizationId` (or the acting membership) from the body, a header, or its `:orgSlug`
 * segment: it receives the `TenantContext` that `TenantContextGuard` built from a membership row and
 * passes it on. Every route is `doc.read` — a member bookmarks a document they may read.
 *
 * The per-document toggle lives under `documents/:documentId/bookmark`; the caller's list lives at the
 * distinct top-level `document-bookmarks` so it can never be matched as `documents/:documentId`. Both
 * controllers live in their own module (registered in `app.module.ts`) so the slice touches no file
 * another docs slice appends to.
 */

const DOC_BOOKMARKS_SERVICE = Symbol.for('tmanage.DocBookmarksService');

@Controller('v1/organizations/:orgSlug/documents/:documentId/bookmark')
export class DocumentBookmarkController {
  constructor(@Inject(DOC_BOOKMARKS_SERVICE) private readonly bookmarks: DocBookmarksService) {}

  /** Whether the caller has bookmarked this document. `doc.read`; the document is resolved readable first. */
  @Get()
  @RequireCapability('doc.read')
  async status(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('documentId') documentId: string,
  ): Promise<{ readonly bookmarked: boolean }> {
    requireDocumentId(documentId);
    return this.bookmarks.status(context, principal, documentId);
  }

  /** Bookmark this document for the caller. Idempotent: a repeated PUT returns the same view (200). */
  @Put()
  @RequireCapability('doc.read')
  async add(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('documentId') documentId: string,
  ): Promise<DocBookmarkView> {
    requireDocumentId(documentId);
    return this.bookmarks.add(context, principal, documentId);
  }

  /** Unbookmark this document for the caller. Idempotent: no bookmark is still 204. */
  @Delete()
  @RequireCapability('doc.read')
  @HttpCode(204)
  async remove(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('documentId') documentId: string,
  ): Promise<void> {
    requireDocumentId(documentId);
    await this.bookmarks.remove(context, principal, documentId);
  }
}

@Controller('v1/organizations/:orgSlug/document-bookmarks')
export class MyBookmarksController {
  constructor(@Inject(DOC_BOOKMARKS_SERVICE) private readonly bookmarks: DocBookmarksService) {}

  /** List the caller's bookmarks, newest first, projected to documents the caller can still read. */
  @Get()
  @RequireCapability('doc.read')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<{ readonly bookmarks: readonly DocBookmarkView[] }> {
    return { bookmarks: await this.bookmarks.list(context, principal) };
  }
}

/** A path `documentId` is always required and always a non-empty string. */
function requireDocumentId(documentId: unknown): asserts documentId is string {
  if (typeof documentId !== 'string' || documentId === '') {
    throw new ApiError(400, 'validation_failed', 'documentId is required', [
      { field: 'documentId', message: 'must be a non-empty string' },
    ]);
  }
}

/**
 * DOC bookmarks / favorites (x242). The module that wires both controllers and their shared service.
 * Registered in `app.module.ts` rather than folded into `DocsModule`, so this slice touches no file
 * another docs slice in the same pass appends to.
 */
@Module({})
export class BookmarksModule {
  static register(): DynamicModule {
    const service: Provider = {
      provide: DOC_BOOKMARKS_SERVICE,
      inject: [TENANT_DATABASE],
      useFactory: (database: TenantDatabase) => new DocBookmarksService(database),
    };

    return {
      module: BookmarksModule,
      providers: [service],
      controllers: [DocumentBookmarkController, MyBookmarksController],
    };
  }
}

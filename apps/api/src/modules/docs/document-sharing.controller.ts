import { Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type {
  DocumentSharingService,
  DocumentSharingView,
  RecentDocumentsView,
} from './document-sharing.service.js';

/**
 * Docs sharing (UI rebuild). "Recent" lives at the distinct top-level `recent-documents` so it can
 * never be matched as `documents/:documentId`; the per-document sharing read and the publish /
 * unpublish commands hang off the document. Like every tenant-scoped controller, nothing here reads
 * a tenant from the body, a header or `:orgSlug` — the `TenantContext` comes from the guard.
 */

export const DOCUMENT_SHARING_SERVICE = Symbol.for('tmanage.DocumentSharingService');

@Controller('v1/organizations/:orgSlug/recent-documents')
export class RecentDocumentsController {
  constructor(@Inject(DOCUMENT_SHARING_SERVICE) private readonly sharing: DocumentSharingService) {}

  /**
   * `?projectId=` narrows to one project; `?scope=favourites` to the caller's own bookmarks;
   * `?scope=archived` lists archived docs only (FIX3 item 6).
   */
  @Get()
  @RequireCapability('doc.read')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Query('projectId') projectId?: string,
    @Query('scope') scope?: string,
  ): Promise<RecentDocumentsView> {
    if (scope !== undefined && scope !== 'favourites' && scope !== 'archived') {
      throw new ApiError(400, 'validation_failed', 'scope is invalid', [
        { field: 'scope', message: 'must be "favourites" or "archived" when present' },
      ]);
    }
    return this.sharing.recent(context, principal, {
      ...(typeof projectId === 'string' && projectId !== '' ? { projectId } : {}),
      ...(scope === 'favourites' ? { favourites: true } : {}),
      // FIX3 item 6: the hub's "Archived" list; every other list leaves archived docs out.
      ...(scope === 'archived' ? { archived: true } : {}),
    });
  }
}

@Controller('v1/organizations/:orgSlug/documents/:documentId')
export class DocumentSharingController {
  constructor(@Inject(DOCUMENT_SHARING_SERVICE) private readonly sharing: DocumentSharingService) {}

  @Get('sharing')
  @RequireCapability('doc.read')
  async get(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('documentId') documentId: string,
  ): Promise<DocumentSharingView> {
    requireDocumentId(documentId);
    return this.sharing.get(context, principal, documentId);
  }

  /** Publish to the project's client audience. Idempotent; the service applies `deliverable.publish`. */
  @Post('publish')
  @RequireCapability('doc.write')
  @HttpCode(200)
  async publish(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('documentId') documentId: string,
  ): Promise<DocumentSharingView> {
    requireDocumentId(documentId);
    return this.sharing.setAudience(context, principal, documentId, 'client');
  }

  /** Return the document to internal-only. Same permission as publishing. */
  @Post('unpublish')
  @RequireCapability('doc.write')
  @HttpCode(200)
  async unpublish(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('documentId') documentId: string,
  ): Promise<DocumentSharingView> {
    requireDocumentId(documentId);
    return this.sharing.setAudience(context, principal, documentId, 'internal');
  }
}

function requireDocumentId(documentId: unknown): asserts documentId is string {
  if (typeof documentId !== 'string' || documentId === '') {
    throw new ApiError(400, 'validation_failed', 'documentId is required', [
      { field: 'documentId', message: 'must be a non-empty string' },
    ]);
  }
}

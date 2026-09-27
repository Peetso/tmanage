import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { DocLinksService } from './doc-links.service.js';
import type { DocLinkView } from './doc-links.service.js';

/**
 * DOC links + backlinks (x296). An author links one document to another and removes the link
 * (`doc.write`); any reader lists a document's outgoing links and its "linked from" backlinks
 * (`doc.read`). Like every tenant-scoped controller here it never reads `organizationId` (or the acting
 * membership) from the body, a header, or its `:orgSlug` segment: it receives the `TenantContext` that
 * `TenantContextGuard` built from a membership row and passes it on.
 *
 * Both source and target ids are resolved tenant-scoped **before** the authorize in the service (the
 * Known trap): a cross-tenant id is a 404 with nothing written, never a foreign-key 500. The `links`
 * and `backlinks` segments hang off the same `documents/:documentId` base the rest of the docs module
 * uses.
 */

/** The token under which the docs module provides the shared `DocLinksService`. */
export const DOC_LINKS_SERVICE = Symbol.for('tmanage.DocLinksService');

/** Create-a-link request body. */
interface AddLinkBody {
  readonly targetDocId?: unknown;
}

@Controller('v1/organizations/:orgSlug/documents/:documentId/links')
export class DocLinksController {
  constructor(@Inject(DOC_LINKS_SERVICE) private readonly links: DocLinksService) {}

  /** List a document's outgoing links, newest first, for a caller who may read it (`doc.read`). */
  @Get()
  @RequireCapability('doc.read')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('documentId') documentId: string,
  ): Promise<{ readonly links: readonly DocLinkView[] }> {
    requireDocumentId(documentId);
    return { links: await this.links.listOutgoing(context, principal, documentId) };
  }

  /**
   * Link this document to another (`doc.write`). Idempotent: a repeated create returns the same view,
   * never a second row. A self-link is a 400; a missing/cross-tenant end is a 404 with nothing written.
   */
  @Post()
  @RequireCapability('doc.write')
  async add(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('documentId') documentId: string,
    @Body() body: AddLinkBody,
  ): Promise<DocLinkView> {
    requireDocumentId(documentId);
    const targetDocId = typeof body?.targetDocId === 'string' ? body.targetDocId.trim() : undefined;
    if (targetDocId === undefined || targetDocId === '') {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: 'targetDocId', message: 'must be a non-empty string' },
      ]);
    }
    return this.links.add(context, principal, documentId, targetDocId);
  }

  /** Remove a link from this document to another (`doc.write`). Idempotent: no link is still 204. */
  @Delete(':targetDocId')
  @RequireCapability('doc.write')
  @HttpCode(204)
  async remove(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('documentId') documentId: string,
    @Param('targetDocId') targetDocId: string,
  ): Promise<void> {
    requireDocumentId(documentId);
    requireTargetDocId(targetDocId);
    await this.links.remove(context, principal, documentId, targetDocId);
  }
}

@Controller('v1/organizations/:orgSlug/documents/:documentId/backlinks')
export class DocBacklinksController {
  constructor(@Inject(DOC_LINKS_SERVICE) private readonly links: DocLinksService) {}

  /**
   * List the documents that link TO this document ("linked from"), newest first, for a caller who may
   * read it (`doc.read`). Read-only: it is projected to the source documents the caller can still read.
   */
  @Get()
  @RequireCapability('doc.read')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('documentId') documentId: string,
  ): Promise<{ readonly backlinks: readonly DocLinkView[] }> {
    requireDocumentId(documentId);
    return { backlinks: await this.links.listBacklinks(context, principal, documentId) };
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

/** A path `targetDocId` is always required and always a non-empty string. */
function requireTargetDocId(targetDocId: unknown): asserts targetDocId is string {
  if (typeof targetDocId !== 'string' || targetDocId === '') {
    throw new ApiError(400, 'validation_failed', 'targetDocId is required', [
      { field: 'targetDocId', message: 'must be a non-empty string' },
    ]);
  }
}

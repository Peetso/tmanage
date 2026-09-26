import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { DOCUMENT_COMMENTS_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { DocumentCommentsService } from './document-comments.service.js';
import type { DocumentCommentView } from './document-comments.service.js';

/**
 * Docs "collaboration later" (x132). The document-comments endpoints: list a document's comments and
 * add one, both keyed by the document id in the path.
 *
 * Like every tenant-scoped controller here it never reads `organizationId` from the body, a header,
 * or its own `:orgSlug` segment: it receives the `TenantContext` that `TenantContextGuard` built and
 * passes it on. The id in the path is resolved tenant-scoped **before** the write in the service (the
 * Known trap): a cross-tenant `documentId` is a 404 with nothing written, never a foreign-key 500.
 */

/** Add-a-comment request body. */
interface AddCommentBody {
  readonly body?: unknown;
}

@Controller('v1/organizations/:orgSlug/documents/:documentId/comments')
export class DocumentCommentsController {
  constructor(
    @Inject(DOCUMENT_COMMENTS_SERVICE) private readonly comments: DocumentCommentsService,
  ) {}

  /** List a document's comments, oldest first, for a caller who may read the document (`doc.read`). */
  @Get()
  @RequireCapability('doc.read')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('documentId') documentId: string,
    @Query('after') after?: string,
    @Query('limit') limit?: string,
  ): Promise<{ readonly comments: readonly DocumentCommentView[] }> {
    requireDocumentId(documentId);

    const parsedLimit = limit === undefined ? undefined : Number(limit);
    if (parsedLimit !== undefined && !Number.isSafeInteger(parsedLimit)) {
      throw new ApiError(400, 'validation_failed', 'limit must be an integer', [
        { field: 'limit', message: 'must be an integer' },
      ]);
    }

    return {
      comments: await this.comments.list(context, principal, documentId, {
        ...(after ? { after } : {}),
        ...(parsedLimit !== undefined ? { limit: parsedLimit } : {}),
      }),
    };
  }

  /** Add a comment to a document (`doc.write`). */
  @Post()
  @RequireCapability('doc.write')
  @HttpCode(201)
  async add(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('documentId') documentId: string,
    @Body() body: AddCommentBody,
  ): Promise<DocumentCommentView> {
    requireDocumentId(documentId);

    const commentBody = typeof body?.body === 'string' ? body.body.trim() : undefined;
    if (commentBody === undefined || commentBody === '') {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: 'body', message: 'must be a non-empty string' },
      ]);
    }
    if (commentBody.length > DocumentCommentsService.maxBodyLength) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        {
          field: 'body',
          message: `must be ${DocumentCommentsService.maxBodyLength} characters or fewer`,
        },
      ]);
    }

    return this.comments.add(context, principal, documentId, commentBody);
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

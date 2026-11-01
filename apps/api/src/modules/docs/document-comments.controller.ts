import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { DOCUMENT_COMMENTS_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { DocumentCommentsService } from './document-comments.service.js';
import type { DocumentCommentView } from './document-comments.service.js';

/**
 * Docs "collaboration later" (x132). The document-comments endpoints: list a document's comments and
 * add one, both keyed by the document id in the path. R5 adds anchors (a comment on selected text) and
 * resolve/unresolve.
 *
 * Like every tenant-scoped controller here it never reads `organizationId` from the body, a header,
 * or its own `:orgSlug` segment: it receives the `TenantContext` that `TenantContextGuard` built and
 * passes it on. The id in the path is resolved tenant-scoped **before** the write in the service (the
 * Known trap): a cross-tenant `documentId` is a 404 with nothing written, never a foreign-key 500.
 */

/** Add-a-comment request body. */
interface AddCommentBody {
  readonly body?: unknown;
  /** R5: the `mark[data-comment]` id in the document body this comment hangs on. */
  readonly anchorId?: unknown;
  /** R5: the selected text at the time of commenting, shown above the thread. */
  readonly anchorQuote?: unknown;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ANCHOR_QUOTE = 500;

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

    const anchor = parseAnchor(body);
    return this.comments.add(context, principal, documentId, commentBody, anchor);
  }

  /** R5: mark a comment thread resolved (`doc.write`, relation-gated like add). */
  @Post(':commentId/resolve')
  @RequireCapability('doc.write')
  @HttpCode(200)
  async resolve(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('documentId') documentId: string,
    @Param('commentId') commentId: string,
  ): Promise<DocumentCommentView> {
    requireDocumentId(documentId);
    requireDocumentId(commentId);
    return this.comments.setResolved(context, principal, documentId, commentId, true);
  }

  /** R5: reopen a resolved comment thread. */
  @Delete(':commentId/resolve')
  @RequireCapability('doc.write')
  @HttpCode(200)
  async unresolve(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('documentId') documentId: string,
    @Param('commentId') commentId: string,
  ): Promise<DocumentCommentView> {
    requireDocumentId(documentId);
    requireDocumentId(commentId);
    return this.comments.setResolved(context, principal, documentId, commentId, false);
  }
}

/** `anchorId` must be a UUID and `anchorQuote` at most 500 characters; both optional. */
function parseAnchor(body: AddCommentBody | undefined): {
  readonly anchorId: string | null;
  readonly anchorQuote: string | null;
} {
  const anchorId = body?.anchorId ?? null;
  const anchorQuote = body?.anchorQuote ?? null;
  if (anchorId !== null && (typeof anchorId !== 'string' || !UUID.test(anchorId))) {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field: 'anchorId', message: 'must be a UUID' },
    ]);
  }
  if (
    anchorQuote !== null &&
    (typeof anchorQuote !== 'string' || anchorQuote.length > MAX_ANCHOR_QUOTE)
  ) {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      {
        field: 'anchorQuote',
        message: `must be a string of ${MAX_ANCHOR_QUOTE} characters or fewer`,
      },
    ]);
  }
  const quote = typeof anchorQuote === 'string' ? anchorQuote.trim() : '';
  return {
    anchorId: typeof anchorId === 'string' ? anchorId.toLowerCase() : null,
    anchorQuote: anchorId !== null && quote !== '' ? quote : null,
  };
}

/** A path `documentId` is always required and always a non-empty string. */
function requireDocumentId(documentId: unknown): asserts documentId is string {
  if (typeof documentId !== 'string' || documentId === '') {
    throw new ApiError(400, 'validation_failed', 'documentId is required', [
      { field: 'documentId', message: 'must be a non-empty string' },
    ]);
  }
}

import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { DOCUMENTS_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { DocumentView, DocumentsService } from './documents.service.js';

/**
 * DOC-01 (x91). The first docs endpoints: create a project document, list a project's documents,
 * and read one document.
 *
 * Like every tenant-scoped controller here, it never reads `organizationId` from the body, a
 * header, or its own `:orgSlug` segment: it receives the `TenantContext` that
 * `TenantContextGuard` built from a membership row and passes it on. The body shapes carry no
 * tenant field, so there is nothing for a caller to supply and nothing for a handler to prefer
 * over the context.
 */

interface CreateDocumentBody {
  readonly projectId?: unknown;
  readonly title?: unknown;
  readonly body?: unknown;
}

/** `documents.title` is `VARCHAR(300)`. */
const MAX_TITLE_LENGTH = 300;
/** `documents.body` is `TEXT` (max 65_535 bytes). This slice keeps a comfortable ceiling below it. */
const MAX_BODY_LENGTH = 60_000;

@Controller('v1/organizations/:orgSlug/documents')
export class DocumentsController {
  constructor(@Inject(DOCUMENTS_SERVICE) private readonly documents: DocumentsService) {}

  @Get()
  @RequireCapability('doc.read')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Query('projectId') projectId?: string,
    @Query('after') after?: string,
    @Query('limit') limit?: string,
  ): Promise<{ readonly documents: readonly DocumentView[] }> {
    if (typeof projectId !== 'string' || projectId === '') {
      throw new ApiError(400, 'validation_failed', 'projectId is required', [
        { field: 'projectId', message: 'must be a non-empty string' },
      ]);
    }

    const parsedLimit = limit === undefined ? undefined : Number(limit);
    if (parsedLimit !== undefined && !Number.isSafeInteger(parsedLimit)) {
      throw new ApiError(400, 'validation_failed', 'limit must be an integer', [
        { field: 'limit', message: 'must be an integer' },
      ]);
    }

    return {
      documents: await this.documents.list(context, principal, {
        projectId,
        ...(after ? { after } : {}),
        ...(parsedLimit !== undefined ? { limit: parsedLimit } : {}),
      }),
    };
  }

  @Get(':documentId')
  @RequireCapability('doc.read')
  async get(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('documentId') documentId: string,
  ): Promise<DocumentView> {
    if (typeof documentId !== 'string' || documentId === '') {
      throw new ApiError(400, 'validation_failed', 'documentId is required', [
        { field: 'documentId', message: 'must be a non-empty string' },
      ]);
    }
    return this.documents.get(context, principal, documentId);
  }

  @Post()
  @RequireCapability('doc.write')
  @HttpCode(201)
  async create(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: CreateDocumentBody,
  ): Promise<DocumentView> {
    const projectId = typeof body?.projectId === 'string' ? body.projectId : undefined;
    const title = typeof body?.title === 'string' ? body.title.trim() : undefined;
    const documentBody = typeof body?.body === 'string' ? body.body : undefined;

    const details = [
      ...(projectId ? [] : [{ field: 'projectId', message: 'must be a non-empty string' }]),
      ...(title ? [] : [{ field: 'title', message: 'must be a non-empty string' }]),
      ...(title && title.length > MAX_TITLE_LENGTH
        ? [{ field: 'title', message: `must be ${MAX_TITLE_LENGTH} characters or fewer` }]
        : []),
      ...(documentBody === undefined || documentBody === ''
        ? [{ field: 'body', message: 'must be a non-empty string' }]
        : []),
      ...(documentBody !== undefined && documentBody.length > MAX_BODY_LENGTH
        ? [{ field: 'body', message: `must be ${MAX_BODY_LENGTH} characters or fewer` }]
        : []),
    ];

    if (details.length > 0) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
    }
    // Narrowed by the `details.length` check above, which TypeScript cannot see through: the
    // guard is on a separate array rather than on these bindings.
    if (!projectId || !title || documentBody === undefined || documentBody === '') {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
    }

    return this.documents.create(context, principal, {
      projectId,
      title,
      body: documentBody,
    });
  }
}

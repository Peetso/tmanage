import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { DOCUMENTS_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type {
  DocumentTemplateView,
  DocumentVersionView,
  DocumentView,
  DocumentsService,
} from './documents.service.js';

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

/** DOC-02 save-a-version request body. */
interface SaveVersionBody {
  readonly body?: unknown;
}

/** DOC-03 restore request body — the prior version number to forward-append. */
interface RestoreBody {
  readonly versionNo?: unknown;
}

/** DOC-04 create-template request body. */
interface CreateTemplateBody {
  readonly name?: unknown;
  readonly purpose?: unknown;
  readonly body?: unknown;
}

/** DOC-04 apply-template request body — the target project and an optional document title. */
interface ApplyTemplateBody {
  readonly projectId?: unknown;
  readonly title?: unknown;
}

/** `documents.title` is `VARCHAR(300)`. */
const MAX_TITLE_LENGTH = 300;
/** `documents.body` is `TEXT` (max 65_535 bytes). This slice keeps a comfortable ceiling below it. */
const MAX_BODY_LENGTH = 60_000;

@Controller('v1/organizations/:orgSlug/documents')
export class DocumentsController {
  constructor(@Inject(DOCUMENTS_SERVICE) private readonly documents: DocumentsService) {}

  /**
   * DOC-04/ADM-06 (x119). List the tenant's document templates, name-ascending. Declared before
   * `GET :documentId` so the literal `templates` segment is matched as this route rather than as a
   * document id.
   */
  @Get('templates')
  @RequireCapability('doc.read')
  async listTemplates(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Query('after') after?: string,
    @Query('limit') limit?: string,
  ): Promise<{ readonly templates: readonly DocumentTemplateView[] }> {
    const parsedLimit = limit === undefined ? undefined : Number(limit);
    if (parsedLimit !== undefined && !Number.isSafeInteger(parsedLimit)) {
      throw new ApiError(400, 'validation_failed', 'limit must be an integer', [
        { field: 'limit', message: 'must be an integer' },
      ]);
    }
    return {
      templates: await this.documents.listTemplates(context, principal, {
        ...(after ? { after } : {}),
        ...(parsedLimit !== undefined ? { limit: parsedLimit } : {}),
      }),
    };
  }

  /**
   * DOC-04/ADM-06 (x119). Create an org-scoped template. Declared before `POST :documentId/…`
   * routes; its literal `templates` first segment cannot collide with a document id.
   */
  @Post('templates')
  @RequireCapability('doc.write')
  @HttpCode(201)
  async createTemplate(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: CreateTemplateBody,
  ): Promise<DocumentTemplateView> {
    const name = typeof body?.name === 'string' ? body.name.trim() : undefined;
    const purpose = typeof body?.purpose === 'string' ? body.purpose.trim() : undefined;
    const templateBody = typeof body?.body === 'string' ? body.body : undefined;

    const details = [
      ...(name ? [] : [{ field: 'name', message: 'must be a non-empty string' }]),
      ...(name && name.length > MAX_TITLE_LENGTH
        ? [{ field: 'name', message: `must be ${MAX_TITLE_LENGTH} characters or fewer` }]
        : []),
      ...(purpose ? [] : [{ field: 'purpose', message: 'must be a non-empty string' }]),
      ...(purpose && purpose.length > MAX_TITLE_LENGTH
        ? [{ field: 'purpose', message: `must be ${MAX_TITLE_LENGTH} characters or fewer` }]
        : []),
      ...(templateBody === undefined || templateBody === ''
        ? [{ field: 'body', message: 'must be a non-empty string' }]
        : []),
      ...(templateBody !== undefined && templateBody.length > MAX_BODY_LENGTH
        ? [{ field: 'body', message: `must be ${MAX_BODY_LENGTH} characters or fewer` }]
        : []),
    ];

    if (details.length > 0) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
    }
    // Narrowed by the `details.length` check above, which TypeScript cannot see through.
    if (!name || !purpose || templateBody === undefined || templateBody === '') {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
    }

    return this.documents.createTemplate(context, principal, {
      name,
      purpose,
      body: templateBody,
    });
  }

  /**
   * DOC-04/ADM-06 (x119). Apply a template to a project — create a new document seeded from the
   * template body. The template and the target project are resolved tenant-scoped before the write
   * (Known-trap): an unknown or cross-tenant id is 404, never a 500.
   */
  @Post('templates/:templateId/apply')
  @RequireCapability('doc.write')
  @HttpCode(201)
  async applyTemplate(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('templateId') templateId: string,
    @Body() body: ApplyTemplateBody,
  ): Promise<DocumentView> {
    if (typeof templateId !== 'string' || templateId === '') {
      throw new ApiError(400, 'validation_failed', 'templateId is required', [
        { field: 'templateId', message: 'must be a non-empty string' },
      ]);
    }
    const projectId = typeof body?.projectId === 'string' ? body.projectId : undefined;
    const title = typeof body?.title === 'string' ? body.title.trim() : undefined;

    const details = [
      ...(projectId ? [] : [{ field: 'projectId', message: 'must be a non-empty string' }]),
      ...(title && title.length > MAX_TITLE_LENGTH
        ? [{ field: 'title', message: `must be ${MAX_TITLE_LENGTH} characters or fewer` }]
        : []),
    ];
    if (details.length > 0) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
    }
    if (!projectId) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
    }

    return this.documents.applyTemplate(context, principal, templateId, {
      projectId,
      ...(title ? { title } : {}),
    });
  }

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

  /**
   * DOC-03. List a document's versions, newest first. `doc.read`, then the service resolves the
   * document tenant-scoped and applies the relation check (a document the caller cannot read is
   * 404, not 403).
   */
  @Get(':documentId/versions')
  @RequireCapability('doc.read')
  async listVersions(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('documentId') documentId: string,
  ): Promise<{ readonly versions: readonly DocumentVersionView[] }> {
    requireDocumentId(documentId);
    return { versions: await this.documents.listVersions(context, principal, documentId) };
  }

  /**
   * DOC-03 compare. Read one snapshot of a document by its version number.
   */
  @Get(':documentId/versions/:versionNo')
  @RequireCapability('doc.read')
  async getVersion(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('documentId') documentId: string,
    @Param('versionNo') versionNo: string,
  ): Promise<DocumentVersionView> {
    requireDocumentId(documentId);
    return this.documents.getVersion(context, principal, documentId, parseVersionNo(versionNo));
  }

  /**
   * DOC-02. Save a new version of a document: append an immutable snapshot and bump the current
   * body in one transaction. `doc.write`.
   */
  @Post(':documentId/versions')
  @RequireCapability('doc.write')
  @HttpCode(201)
  async saveVersion(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('documentId') documentId: string,
    @Body() body: SaveVersionBody,
  ): Promise<DocumentVersionView> {
    requireDocumentId(documentId);
    const documentBody = typeof body?.body === 'string' ? body.body : undefined;
    if (documentBody === undefined || documentBody === '') {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: 'body', message: 'must be a non-empty string' },
      ]);
    }
    if (documentBody.length > MAX_BODY_LENGTH) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: 'body', message: `must be ${MAX_BODY_LENGTH} characters or fewer` },
      ]);
    }
    return this.documents.saveVersion(context, principal, documentId, documentBody);
  }

  /**
   * DOC-03 restore. Write a NEW version equal to a prior snapshot (forward-append, history is never
   * mutated) and bump the current body to it. `doc.write`.
   */
  @Post(':documentId/restore')
  @RequireCapability('doc.write')
  @HttpCode(201)
  async restore(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('documentId') documentId: string,
    @Body() body: RestoreBody,
  ): Promise<DocumentVersionView> {
    requireDocumentId(documentId);
    return this.documents.restore(
      context,
      principal,
      documentId,
      requireVersionNo(body?.versionNo),
    );
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

/** Parse a `:versionNo` path segment to a positive integer, or 400. */
function parseVersionNo(raw: string): number {
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new ApiError(400, 'validation_failed', 'versionNo must be a positive integer', [
      { field: 'versionNo', message: 'must be a positive integer' },
    ]);
  }
  return parsed;
}

/** Validate the `versionNo` in a restore body — a positive integer, or 400. */
function requireVersionNo(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 1) {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field: 'versionNo', message: 'must be a positive integer' },
    ]);
  }
  return raw;
}

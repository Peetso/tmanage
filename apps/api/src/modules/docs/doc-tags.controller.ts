import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Module,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { DocTagsService } from './doc-tags.service.js';
import type { DocTagView, DocumentTagView } from './doc-tags.service.js';

/**
 * x269's HTTP surface — document tags / labels (Docs module).
 *
 * Two shapes of resource on one controller. Tag *definitions* are org-scoped (`…/doc-tags`); a tag
 * *assignment* is a sub-resource of a document (`…/documents/:documentId/tags`), the way document
 * comments and bookmarks are — the parent id is in the path, and the service resolves it
 * tenant-scoped before it authorizes or writes. The capability gate is coarse (`doc.read` to list,
 * `doc.write` to define / assign / unassign); the row-level 404 decision is the service's, against the
 * resolved parent. The controller never reads `organizationId` from the body, a header or its
 * `:orgSlug` segment: it passes on the `TenantContext` that `TenantContextGuard` built.
 *
 * Wired in its own module (registered in `app.module.ts`) so this slice touches no file another docs
 * slice appends to.
 */

const DOC_TAGS_SERVICE = Symbol.for('tmanage.DocTagsService');

interface DefineTagBody {
  readonly name?: unknown;
}

@Controller('v1/organizations/:orgSlug')
export class DocTagsController {
  constructor(@Inject(DOC_TAGS_SERVICE) private readonly tags: DocTagsService) {}

  /** The organization's tag definitions, name-ascending. `doc.read`. */
  @Get('doc-tags')
  @RequireCapability('doc.read')
  async list(@Ctx() context: TenantContext): Promise<{ readonly tags: readonly DocTagView[] }> {
    return { tags: await this.tags.listDefinitions(context) };
  }

  /** Define a tag. `doc.write`. Duplicate name → 409. */
  @Post('doc-tags')
  @RequireCapability('doc.write')
  @HttpCode(201)
  async define(@Ctx() context: TenantContext, @Body() body: DefineTagBody): Promise<DocTagView> {
    return this.tags.define(context, body?.name);
  }

  /** The tags assigned to a document the caller can read. `doc.read`. */
  @Get('documents/:documentId/tags')
  @RequireCapability('doc.read')
  async listForDocument(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('documentId') documentId: string,
  ): Promise<{ readonly tags: readonly DocumentTagView[] }> {
    requireId(documentId, 'documentId');
    return { tags: await this.tags.listForDocument(context, principal, documentId) };
  }

  /** Tag a document (idempotent). `doc.write`. Unknown/cross-tenant document or tag → 404. */
  @Put('documents/:documentId/tags/:tagId')
  @RequireCapability('doc.write')
  async assign(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('documentId') documentId: string,
    @Param('tagId') tagId: string,
  ): Promise<DocumentTagView> {
    requireId(documentId, 'documentId');
    requireId(tagId, 'tagId');
    return this.tags.assign(context, principal, documentId, tagId);
  }

  /** Untag a document. `doc.write`. A tag that is not present is still 204. */
  @Delete('documents/:documentId/tags/:tagId')
  @RequireCapability('doc.write')
  @HttpCode(204)
  async remove(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('documentId') documentId: string,
    @Param('tagId') tagId: string,
  ): Promise<void> {
    requireId(documentId, 'documentId');
    requireId(tagId, 'tagId');
    await this.tags.remove(context, principal, documentId, tagId);
  }
}

/** A path segment id is always required and always a non-empty string. */
function requireId(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value === '') {
    throw new ApiError(400, 'validation_failed', `${field} is required`, [
      { field, message: 'must be a non-empty string' },
    ]);
  }
}

/**
 * x269 — document tags / labels. The module that wires the controller and its service. Registered in
 * `app.module.ts` rather than folded into `DocsModule`, so this slice touches no file another docs
 * slice in the same pass appends to.
 */
@Module({})
export class DocTagsModule {
  static register(): DynamicModule {
    const service: Provider = {
      provide: DOC_TAGS_SERVICE,
      inject: [TENANT_DATABASE],
      useFactory: (database: TenantDatabase) => new DocTagsService(database),
    };

    return {
      module: DocTagsModule,
      providers: [service],
      controllers: [DocTagsController],
    };
  }
}

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
import { DocCollectionsService } from './collections.service.js';
import type { CollectionDocumentView, CollectionView } from './collections.service.js';

/**
 * DOC collections (x264). Create a named collection, list the tenant's collections, list one
 * collection's member documents, and add/remove a document. Like every tenant-scoped controller here it
 * never reads `organizationId` (or the acting membership) from the body, a header, or its `:orgSlug`
 * segment: it receives the `TenantContext` that `TenantContextGuard` built from a membership row and
 * passes it on. Reads are `doc.read`; writes are `doc.write`. It lives in its own module (registered in
 * `app.module.ts`) so the slice touches no file another docs slice appends to.
 */

const DOC_COLLECTIONS_SERVICE = Symbol.for('tmanage.DocCollectionsService');

/** `doc_collections.name` is `VARCHAR(200)`. */
const MAX_NAME_LENGTH = 200;

/** Create-a-collection request body. */
interface CreateCollectionBody {
  readonly name?: unknown;
}

@Controller('v1/organizations/:orgSlug/doc-collections')
export class DocCollectionsController {
  constructor(
    @Inject(DOC_COLLECTIONS_SERVICE) private readonly collections: DocCollectionsService,
  ) {}

  /** List the tenant's collections, name-ascending. `doc.read`. */
  @Get()
  @RequireCapability('doc.read')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<{ readonly collections: readonly CollectionView[] }> {
    return { collections: await this.collections.list(context, principal) };
  }

  /** Create a collection. `doc.write`. A duplicate name is a 409. */
  @Post()
  @RequireCapability('doc.write')
  @HttpCode(201)
  async create(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: CreateCollectionBody,
  ): Promise<CollectionView> {
    const name = typeof body?.name === 'string' ? body.name.trim() : undefined;
    if (!name) {
      throw new ApiError(400, 'validation_failed', 'name is required', [
        { field: 'name', message: 'must be a non-empty string' },
      ]);
    }
    if (name.length > MAX_NAME_LENGTH) {
      throw new ApiError(400, 'validation_failed', 'name is too long', [
        { field: 'name', message: `must be ${MAX_NAME_LENGTH} characters or fewer` },
      ]);
    }
    return this.collections.create(context, principal, name);
  }

  /** List one collection's member documents, projected to documents the caller can still read. `doc.read`. */
  @Get(':collectionId')
  @RequireCapability('doc.read')
  async documents(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('collectionId') collectionId: string,
  ): Promise<{ readonly documents: readonly CollectionDocumentView[] }> {
    requireId(collectionId, 'collectionId');
    return { documents: await this.collections.listDocuments(context, principal, collectionId) };
  }

  /** Add a document to a collection. `doc.write`. Idempotent: a repeated PUT returns the same view (200). */
  @Put(':collectionId/documents/:documentId')
  @RequireCapability('doc.write')
  async addDocument(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('collectionId') collectionId: string,
    @Param('documentId') documentId: string,
  ): Promise<CollectionDocumentView> {
    requireId(collectionId, 'collectionId');
    requireId(documentId, 'documentId');
    return this.collections.addDocument(context, principal, collectionId, documentId);
  }

  /** Remove a document from a collection. `doc.write`. Idempotent: no membership is still 204. */
  @Delete(':collectionId/documents/:documentId')
  @RequireCapability('doc.write')
  @HttpCode(204)
  async removeDocument(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('collectionId') collectionId: string,
    @Param('documentId') documentId: string,
  ): Promise<void> {
    requireId(collectionId, 'collectionId');
    requireId(documentId, 'documentId');
    await this.collections.removeDocument(context, principal, collectionId, documentId);
  }
}

/** A path id is always required and always a non-empty string. */
function requireId(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value === '') {
    throw new ApiError(400, 'validation_failed', `${field} is required`, [
      { field, message: 'must be a non-empty string' },
    ]);
  }
}

/**
 * DOC collections (x264). The module that wires the controller and its service. Registered in
 * `app.module.ts` rather than folded into `DocsModule`, so this slice touches no file another docs
 * slice in the same pass appends to.
 */
@Module({})
export class DocCollectionsModule {
  static register(): DynamicModule {
    const service: Provider = {
      provide: DOC_COLLECTIONS_SERVICE,
      inject: [TENANT_DATABASE],
      useFactory: (database: TenantDatabase) => new DocCollectionsService(database),
    };

    return {
      module: DocCollectionsModule,
      providers: [service],
      controllers: [DocCollectionsController],
    };
  }
}

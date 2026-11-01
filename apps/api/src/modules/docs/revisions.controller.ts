import { Body, Controller, Get, HttpCode, Inject, Module, Param, Post } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { RevisionsService } from './revisions.service.js';
import type { DocRevisionView } from './revisions.service.js';

/**
 * DOC revision history (x241). Capture a revision, list the trail newest-first, and restore a prior
 * revision. Like every tenant-scoped controller here it never reads `organizationId` from the body,
 * a header, or its `:orgSlug` segment: it receives the `TenantContext` that `TenantContextGuard`
 * built from a membership row and passes it on.
 *
 * The path is `documents/:documentId/revisions`, a sibling of x112's `.../versions`; the two never
 * collide, and this controller lives in its own module (registered in `app.module.ts`) so the slice
 * touches no file another docs slice appends to.
 */

/**
 * `doc_revisions.body_snapshot` is MEDIUMTEXT since 0277, like `documents.body` (0272), so a
 * snapshot takes the document body's own ceiling.
 */
const MAX_BODY_LENGTH = 1_000_000;

/** Capture-revision request body — the snapshot to append. */
interface CaptureRevisionBody {
  readonly bodySnapshot?: unknown;
}

const DOC_REVISIONS_SERVICE = Symbol.for('tmanage.RevisionsService');

@Controller('v1/organizations/:orgSlug/documents/:documentId/revisions')
export class RevisionsController {
  constructor(@Inject(DOC_REVISIONS_SERVICE) private readonly revisions: RevisionsService) {}

  /**
   * List a document's revisions, newest first. `doc.read`, then the service resolves the document
   * tenant-scoped and applies the relation check (a document the caller cannot read is 404).
   */
  @Get()
  @RequireCapability('doc.read')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('documentId') documentId: string,
  ): Promise<{ readonly revisions: readonly DocRevisionView[] }> {
    requireDocumentId(documentId);
    return { revisions: await this.revisions.list(context, principal, documentId) };
  }

  /**
   * Capture a revision: append an immutable snapshot and bump the current body in one transaction.
   * `doc.write`.
   */
  @Post()
  @RequireCapability('doc.write')
  @HttpCode(201)
  async capture(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('documentId') documentId: string,
    @Body() body: CaptureRevisionBody,
  ): Promise<DocRevisionView> {
    requireDocumentId(documentId);
    const snapshot = typeof body?.bodySnapshot === 'string' ? body.bodySnapshot : undefined;
    if (snapshot === undefined || snapshot === '') {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: 'bodySnapshot', message: 'must be a non-empty string' },
      ]);
    }
    if (snapshot.length > MAX_BODY_LENGTH) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: 'bodySnapshot', message: `must be ${MAX_BODY_LENGTH} characters or fewer` },
      ]);
    }
    return this.revisions.capture(context, principal, documentId, snapshot);
  }

  /**
   * Restore a revision: write a NEW revision equal to a prior snapshot (forward-append, history is
   * never mutated) and bump the current body to it. `doc.write`. An unknown revision id is 404.
   */
  @Post(':revId/restore')
  @RequireCapability('doc.write')
  @HttpCode(201)
  async restore(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('documentId') documentId: string,
    @Param('revId') revId: string,
  ): Promise<DocRevisionView> {
    requireDocumentId(documentId);
    if (typeof revId !== 'string' || revId === '') {
      throw new ApiError(400, 'validation_failed', 'revId is required', [
        { field: 'revId', message: 'must be a non-empty string' },
      ]);
    }
    return this.revisions.restore(context, principal, documentId, revId);
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
 * DOC revision history (x241). The module that wires the controller and its service. Registered in
 * `app.module.ts` rather than folded into `DocsModule`, so this slice touches no file another docs
 * slice in the same pass appends to.
 */
@Module({})
export class RevisionsModule {
  static register(): DynamicModule {
    const service: Provider = {
      provide: DOC_REVISIONS_SERVICE,
      inject: [TENANT_DATABASE],
      useFactory: (database: TenantDatabase) => new RevisionsService(database),
    };

    return {
      module: RevisionsModule,
      providers: [service],
      controllers: [RevisionsController],
    };
  }
}

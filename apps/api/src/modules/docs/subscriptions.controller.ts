import { Controller, Delete, Get, HttpCode, Inject, Module, Param, Put } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { DocSubscriptionsService } from './subscriptions.service.js';
import type { DocSubscriptionView } from './subscriptions.service.js';

/**
 * DOC subscriptions (x312). Follow a document, unfollow it, read the caller's follow status of one
 * document, and list the caller's subscriptions. Like every tenant-scoped controller here it never
 * reads `organizationId` (or the acting membership) from the body, a header, or its `:orgSlug` segment:
 * it receives the `TenantContext` that `TenantContextGuard` built from a membership row and passes it
 * on. Every route is `doc.read` — a member follows a document they may read.
 *
 * The per-document toggle lives under `documents/:documentId/subscription`; the caller's list lives at
 * the distinct top-level `me/doc-subscriptions` so it can never be matched as `documents/:documentId`.
 * Both controllers live in their own module (registered in `app.module.ts`) so the slice touches no file
 * another docs slice appends to.
 */

const DOC_SUBSCRIPTIONS_SERVICE = Symbol.for('tmanage.DocSubscriptionsService');

@Controller('v1/organizations/:orgSlug/documents/:documentId/subscription')
export class DocumentSubscriptionController {
  constructor(
    @Inject(DOC_SUBSCRIPTIONS_SERVICE) private readonly subscriptions: DocSubscriptionsService,
  ) {}

  /** Whether the caller is subscribed to this document. `doc.read`; the document is resolved readable first. */
  @Get()
  @RequireCapability('doc.read')
  async status(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('documentId') documentId: string,
  ): Promise<{ readonly subscribed: boolean }> {
    requireDocumentId(documentId);
    return this.subscriptions.status(context, principal, documentId);
  }

  /** Subscribe the caller to this document. Idempotent: a repeated PUT returns the same view (200). */
  @Put()
  @RequireCapability('doc.read')
  async subscribe(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('documentId') documentId: string,
  ): Promise<DocSubscriptionView> {
    requireDocumentId(documentId);
    return this.subscriptions.subscribe(context, principal, documentId);
  }

  /** Unsubscribe the caller from this document. Idempotent: no subscription is still 204. */
  @Delete()
  @RequireCapability('doc.read')
  @HttpCode(204)
  async unsubscribe(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('documentId') documentId: string,
  ): Promise<void> {
    requireDocumentId(documentId);
    await this.subscriptions.unsubscribe(context, principal, documentId);
  }
}

@Controller('v1/organizations/:orgSlug/me/doc-subscriptions')
export class MySubscriptionsController {
  constructor(
    @Inject(DOC_SUBSCRIPTIONS_SERVICE) private readonly subscriptions: DocSubscriptionsService,
  ) {}

  /** List the caller's subscriptions, newest first, projected to documents the caller can still read. */
  @Get()
  @RequireCapability('doc.read')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<{ readonly subscriptions: readonly DocSubscriptionView[] }> {
    return { subscriptions: await this.subscriptions.list(context, principal) };
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
 * DOC subscriptions (x312). The module that wires both controllers and their shared service. Registered
 * in `app.module.ts` rather than folded into `DocsModule`, so this slice touches no file another docs
 * slice in the same pass appends to.
 */
@Module({})
export class SubscriptionsModule {
  static register(): DynamicModule {
    const service: Provider = {
      provide: DOC_SUBSCRIPTIONS_SERVICE,
      inject: [TENANT_DATABASE],
      useFactory: (database: TenantDatabase) => new DocSubscriptionsService(database),
    };

    return {
      module: SubscriptionsModule,
      providers: [service],
      controllers: [DocumentSubscriptionController, MySubscriptionsController],
    };
  }
}

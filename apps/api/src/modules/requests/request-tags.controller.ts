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
} from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { RequestTagRow } from '../../common/database/schema.js';
import { RequestTagsService } from './request-tags.service.js';

/**
 * x316's HTTP surface — free-text triage labels on a client request (Requests module 11).
 *
 * Tags are a sub-resource of a client request, the way the aging read is a roll-up on the same base:
 * the parent id is in the path (`…/client-requests/:clientRequestId/tags`), and the service resolves
 * it tenant-scoped before it authorizes or writes. Every route is behind `client_request.triage`,
 * REQ-001's internal-only capability (in `INTERNAL_ONLY_CAPABILITIES`), reused — no new capability
 * and no `capabilities.ts` edit. A client role never reaches these paths; a cross-tenant request id
 * is a 404 with no write, produced in the service before `authorize()`.
 *
 * A module of its own, registered from `app.module.ts`, so the requests slices stay file-disjoint
 * from the list/triage and aging controllers.
 */

/** One tag on a client request. Element type of {@link RequestTagsView.tags}. */
export interface RequestTagItem {
  readonly id: string;
  readonly clientRequestId: string;
  readonly label: string;
  readonly createdByUserId: string;
  readonly createdAt: string;
}

/** The tags on one client request. Paired with the web shape in `e2e/contracts`. */
export interface RequestTagsView {
  readonly clientRequestId: string;
  readonly tags: readonly RequestTagItem[];
}

interface AddTagBody {
  readonly label?: unknown;
}

function toItem(row: RequestTagRow): RequestTagItem {
  return {
    id: row.id,
    clientRequestId: row.clientRequestId,
    label: row.label,
    createdByUserId: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  };
}

function toView(clientRequestId: string, rows: readonly RequestTagRow[]): RequestTagsView {
  return { clientRequestId, tags: rows.map(toItem) };
}

@Controller('v1/organizations/:orgSlug/client-requests/:clientRequestId/tags')
export class RequestTagsController {
  constructor(@Inject(RequestTagsService) private readonly tags: RequestTagsService) {}

  /** The tags on a request, label-ascending. Cross-tenant / unknown request → 404. */
  @Get()
  @RequireCapability('client_request.triage')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('clientRequestId') clientRequestId: string,
  ): Promise<RequestTagsView> {
    const rows = await this.tags.listForRequest(context, principal, clientRequestId);
    return toView(clientRequestId, rows);
  }

  /**
   * Tag a request with a free-text label, then return the request's full tag set. Empty / over-length
   * label → 400; a label already present → 409; cross-tenant / unknown request → 404 (no write).
   */
  @Post()
  @RequireCapability('client_request.triage')
  @HttpCode(201)
  async add(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('clientRequestId') clientRequestId: string,
    @Body() body: AddTagBody,
  ): Promise<RequestTagsView> {
    await this.tags.addTag(context, principal, clientRequestId, body?.label);
    const rows = await this.tags.listForRequest(context, principal, clientRequestId);
    return toView(clientRequestId, rows);
  }

  /** Untag a request. A tag that is not present is a no-op 204; cross-tenant / unknown request → 404. */
  @Delete(':tagId')
  @RequireCapability('client_request.triage')
  @HttpCode(204)
  async remove(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('clientRequestId') clientRequestId: string,
    @Param('tagId') tagId: string,
  ): Promise<void> {
    await this.tags.removeTag(context, principal, clientRequestId, tagId);
  }
}

/**
 * x316's wiring — a self-contained module registered from `app.module.ts` (the shared append point)
 * rather than folded into {@link RequestsModule}, so the requests slices stay file-disjoint. The
 * service is constructed with the `@Global` `TENANT_DATABASE`; its repositories are stateless and
 * built inside it.
 */
@Module({})
export class RequestTagsModule {
  static register(): DynamicModule {
    return {
      module: RequestTagsModule,
      providers: [
        {
          provide: RequestTagsService,
          inject: [TENANT_DATABASE],
          useFactory: (database: TenantDatabase) => new RequestTagsService(database),
        },
      ],
      controllers: [RequestTagsController],
    };
  }
}

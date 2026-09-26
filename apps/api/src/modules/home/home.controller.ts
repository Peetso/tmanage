import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { HOME_SERVICE } from '../../common/http/tokens.js';
import { SAVED_CONTEXT_ENTITY_TYPES } from '../../common/database/schema.js';
import type { SavedContextEntityType } from '../../common/database/schema.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type {
  HomeService,
  HomeSummaryView,
  MyDayView,
  SavedContextView,
  WaitingView,
} from './home.service.js';

/** The pin request body — every field arrives as `unknown` and is validated in the route. */
interface PinContextBody {
  readonly entityType?: unknown;
  readonly entityId?: unknown;
  readonly projectId?: unknown;
}

function isSavedContextEntityType(value: unknown): value is SavedContextEntityType {
  return (
    typeof value === 'string' && (SAVED_CONTEXT_ENTITY_TYPES as readonly string[]).includes(value)
  );
}

/**
 * HOME-03's HTTP surface — the My Day personal-work read.
 *
 * The same shape as `WorkItemsController`: it reads no `organizationId` from anywhere, because
 * `TenantContextGuard` built the `TenantContext` from a membership row, and it names the acting
 * user by the `Principal` the session resolved, never by a field a caller could supply.
 *
 * Behind `work.read`, the capability every work read uses — reused rather than a new `home.read`
 * so this slice stays off `capabilities.ts` and the role grid (a dedicated capability is the
 * clean follow-up once the module grows). A caller without `work.read` is refused here exactly
 * as the sibling work reads refuse.
 */
@Controller('v1/organizations/:orgSlug/home')
export class HomeController {
  constructor(@Inject(HOME_SERVICE) private readonly home: HomeService) {}

  @Get('my-day')
  @RequireCapability('work.read')
  async myDay(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<MyDayView> {
    return this.home.myDayOf(context, principal);
  }

  /**
   * HOME-04's Waiting read — across three buckets: approvals pending on the acting user as a
   * reviewer, client requests awaiting their triage, and stale client follow-ups.
   *
   * `@RequireCapability('approval.read')` is the coarse route ceiling, UX only
   * (`25-AUTH-AND-TENANT-ISOLATION` §3), exactly as `ApprovalsController` guards its routes: it
   * admits the roles that could plausibly touch a waiting row and answers nothing about *which*.
   * It still covers the client-request buckets because `client_request.triage`'s holders (owner,
   * org_admin, workspace_admin, manager) are all a subset of `approval.read`'s, so no reader of
   * either bucket is turned away here. The real gate is per bucket in the service: the reviewer
   * relation for approvals (AUTH-08), and the `client_request.triage` relation for client requests
   * — the same gate the requests module's own reads apply. A caller without `approval.read` is
   * refused here as the sibling approval reads refuse.
   *
   * The delegated bucket stays scoped out (no creator/assignee column on `work_items`), a carried
   * data-model gap; it returns once that column lands.
   */
  @Get('waiting')
  @RequireCapability('approval.read')
  async waiting(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<WaitingView> {
    return this.home.waitingOf(context, principal);
  }

  /**
   * HOME-01's hero summary — the derived counts the My Day hero shows.
   *
   * Behind `work.read` like `my-day`: the summary leads with the personal-work counts, and every
   * internal role that holds `work.read` also holds `approval.read`, so the waiting counts are
   * covered too; a client principal (no `work.read`) is refused, as this internal hero should. The
   * counts are aggregated from the same two reads the sections render, each already gated per row,
   * so the hero shows no number a section would not.
   */
  @Get('summary')
  @RequireCapability('work.read')
  async summary(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<HomeSummaryView> {
    return this.home.summaryOf(context, principal);
  }

  /**
   * HOME-05's saved/pinned context, behind `work.read` like the My Day reads — every internal role
   * that reads Home holds it, and a client principal (who has no business with an internal Home) is
   * refused. The three routes take no `organizationId` and no `userId` from anywhere: the tenant is
   * `TenantContextGuard`'s, and a pin is always the acting user's own.
   */
  @Get('saved-context')
  @RequireCapability('work.read')
  async savedContext(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<SavedContextView> {
    return this.home.listSavedContext(context, principal);
  }

  /**
   * Pin an entity. Returns the caller's saved set after the pin (201). Idempotent — a re-pin of the
   * same entity returns the set unchanged. The service resolves `projectId`/`entityId` tenant-scoped
   * before the relation check, so an unknown or cross-tenant id is a 404 (Known trap), never a 500.
   */
  @Post('saved-context')
  @RequireCapability('work.read')
  @HttpCode(201)
  async pin(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: PinContextBody,
  ): Promise<SavedContextView> {
    const details: { field: string; message: string }[] = [];
    if (!isSavedContextEntityType(body?.entityType)) {
      details.push({
        field: 'entityType',
        message: `must be one of ${SAVED_CONTEXT_ENTITY_TYPES.join(', ')}`,
      });
    }
    const entityId = typeof body?.entityId === 'string' ? body.entityId : undefined;
    if (!entityId) details.push({ field: 'entityId', message: 'must be a string' });
    const projectId = typeof body?.projectId === 'string' ? body.projectId : undefined;
    if (!projectId) details.push({ field: 'projectId', message: 'must be a string' });

    if (
      details.length > 0 ||
      !isSavedContextEntityType(body?.entityType) ||
      !entityId ||
      !projectId
    ) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
    }

    return this.home.pinContext(context, principal, {
      entityType: body.entityType,
      entityId,
      projectId,
    });
  }

  /**
   * Unpin by the pin's id. Returns the caller's saved set after removal (200 — nothing new was
   * created). Own-user: an id that is not the caller's own pin is a 404, so a pin's existence is
   * never disclosed to a user it does not belong to.
   */
  @Delete('saved-context/:savedContextId')
  @RequireCapability('work.read')
  @HttpCode(200)
  async unpin(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('savedContextId') savedContextId: string,
  ): Promise<SavedContextView> {
    return this.home.unpinContext(context, principal, savedContextId);
  }
}

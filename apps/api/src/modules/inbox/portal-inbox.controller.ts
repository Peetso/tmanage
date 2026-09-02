import { Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import { isUuid } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { PORTAL_INBOX_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { isPortalInboxMode } from './portal-inbox.service.js';
import type { PortalInboxPageView, PortalInboxService } from './portal-inbox.service.js';

/**
 * The client inbox's HTTP surface — INBOX-001's second half, on the portal path.
 *
 * `/portal/inbox`, not `/inbox?as=client`. `22-SCREEN-BY-SCREEN` §6's "dedicated route" is a
 * security property, as `PortalController` records: a route that served a client projection
 * when asked nicely is one refactor away from serving the internal record. This controller
 * reaches a different service, which builds a different object, through a different
 * authorized read (`getForClient`), and shares no code path with the internal inbox except
 * the repository that names a recipient.
 *
 * ## The capability
 *
 * `client_request.submit` — the one every client role holds and no internal role does. The
 * rows this surface reads are about requests the client submitted, so the capability that
 * put the request in the system is the one that reads what became of it. An internal
 * principal is refused at the door; the service refuses one again, in case the door moves.
 *
 * ## The contract
 *
 * `openapi.yaml` draws one `getInbox` and no portal inbox at all. This route is recorded as a
 * divergence in `docs/implementation-status.md` beside the internal inbox's own — same
 * `before` cursor, same undeclared `limit`, same `POST …/read` — rather than added to a
 * planning document this codebase does not author.
 */
@Controller('v1/organizations/:orgSlug/portal/inbox')
export class PortalInboxController {
  constructor(@Inject(PORTAL_INBOX_SERVICE) private readonly inbox: PortalInboxService) {}

  @Get()
  @RequireCapability('client_request.submit')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Query('mode') mode?: string,
    @Query('before') before?: string,
    @Query('limit') limit?: string,
  ): Promise<PortalInboxPageView> {
    const details: { field: string; message: string }[] = [];

    if (mode !== undefined && !isPortalInboxMode(mode)) {
      details.push({ field: 'mode', message: `${mode} is not a portal inbox mode` });
    }
    const parsedLimit = limit === undefined ? undefined : Number(limit);
    if (parsedLimit !== undefined && (!Number.isSafeInteger(parsedLimit) || parsedLimit < 1)) {
      details.push({ field: 'limit', message: 'must be a positive integer' });
    }
    // A cursor is an id this API handed out; anything else is refused, as on the internal inbox.
    if (before !== undefined && !isUuid(before)) {
      details.push({ field: 'before', message: 'must be a cursor this API returned' });
    }
    if (details.length > 0) {
      throw new ApiError(400, 'validation_failed', 'The query is invalid', details);
    }

    return this.inbox.list(context, principal, {
      ...(mode !== undefined && isPortalInboxMode(mode) ? { mode } : {}),
      ...(before ? { before } : {}),
      ...(parsedLimit === undefined ? {} : { limit: parsedLimit }),
    });
  }

  @Post(':bundleId/read')
  @RequireCapability('client_request.submit')
  @HttpCode(200)
  async markRead(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('bundleId') bundleId: string,
  ): Promise<{ readonly bundleId: string; readonly marked: number }> {
    return this.inbox.markBundleRead(context, principal, bundleId);
  }
}

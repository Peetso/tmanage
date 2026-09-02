import { Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import { isUuid } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { INBOX_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { isInboxMode } from './inbox.service.js';
import type { InboxPageView, InboxService } from './inbox.service.js';

/**
 * INBOX-001's HTTP surface — `openapi.yaml`'s `GET /organizations/{id}/inbox` and the one
 * inline action TM-04 has today.
 *
 * ## The capability, decided rather than invented
 *
 * `12-PERMISSION-MATRIX` names no notification capability, and NOTIF-001 recorded that "the
 * guard declaration is a decision the read surface's ticket must make deliberately rather
 * than this one inventing a capability". The decision: **`work.read`**. It is the one
 * capability every internal role holds — owner through guest — and no client role does, which
 * is exactly TM-04's audience ("Roles: all internal"). The consequence is recorded rather than
 * hidden: `client_request.transitioned.v1` rows are written *to clients* (the submitter), and
 * a client cannot call this route, so those rows have no reader yet. The portal's `CL-08
 * Updates` is a feed of published status updates, not a notification inbox; a client inbox
 * is a projection on a portal path of its own, the way every other client surface is, and it
 * is INBOX-001's second half. Adding a `notification.read` to the domain would put a word in the ceiling table
 * that the matrix does not have, and `CapabilityGuard`'s own doc is explicit that the guard is
 * the coarse half only: the control that matters here is the service's — a recipient reads
 * their own rows, and every object is re-read through its authorized path.
 */
@Controller('v1/organizations/:orgSlug/inbox')
export class InboxController {
  constructor(@Inject(INBOX_SERVICE) private readonly inbox: InboxService) {}

  @Get()
  @RequireCapability('work.read')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Query('mode') mode?: string,
    @Query('before') before?: string,
    @Query('limit') limit?: string,
  ): Promise<InboxPageView> {
    const details: { field: string; message: string }[] = [];

    if (mode !== undefined && !isInboxMode(mode)) {
      details.push({ field: 'mode', message: `${mode} is not an inbox mode` });
    }
    const parsedLimit = limit === undefined ? undefined : Number(limit);
    if (parsedLimit !== undefined && (!Number.isSafeInteger(parsedLimit) || parsedLimit < 1)) {
      details.push({ field: 'limit', message: 'must be a positive integer' });
    }
    // A cursor is an id this API handed out. Anything else compares against every id as
    // text and silently returns some page; the two older `after` cursors accept that, this
    // one does not.
    if (before !== undefined && !isUuid(before)) {
      details.push({ field: 'before', message: 'must be a cursor this API returned' });
    }
    if (details.length > 0) {
      throw new ApiError(400, 'validation_failed', 'The query is invalid', details);
    }

    return this.inbox.list(context, principal, {
      ...(mode !== undefined && isInboxMode(mode) ? { mode } : {}),
      ...(before ? { before } : {}),
      ...(parsedLimit === undefined ? {} : { limit: parsedLimit }),
    });
  }

  @Post(':bundleId/read')
  @RequireCapability('work.read')
  @HttpCode(200)
  async markRead(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('bundleId') bundleId: string,
  ): Promise<{ readonly bundleId: string; readonly marked: number }> {
    return this.inbox.markBundleRead(context, principal, bundleId);
  }
}

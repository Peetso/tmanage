import { Body, Controller, Get, Inject, Param, Put } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type {
  PortalMeetingDetailView,
  PortalMeetingView,
  PortalMeetingsService,
} from './portal-meetings.service.js';

/** BK5: the token the calendar module provides `PortalMeetingsService` under. */
export const PORTAL_MEETINGS_SERVICE = Symbol('PORTAL_MEETINGS_SERVICE');

/**
 * BK5 (0217) — the client portal's meetings: the list and detail of the meetings the calling client
 * person attends, and their own RSVP. Under `/portal` like every client surface, and served by a
 * service whose only query is keyed on the principal's own client membership (see the service).
 *
 * `client_projection.read` for the reads (every client role holds it); the RSVP is the client's
 * answer about their own attendance, so it takes `client_request.submit` — the capability every
 * client role holds for its own writes, as the portal inbox's mark-read does.
 */
@Controller('v1/organizations/:orgSlug/portal/meetings')
export class PortalMeetingsController {
  constructor(@Inject(PORTAL_MEETINGS_SERVICE) private readonly meetings: PortalMeetingsService) {}

  @Get()
  @RequireCapability('client_projection.read')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<{ readonly meetings: readonly PortalMeetingView[] }> {
    return { meetings: await this.meetings.list(context, principal) };
  }

  @Get(':meetingId')
  @RequireCapability('client_projection.read')
  async get(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('meetingId') meetingId: string,
  ): Promise<PortalMeetingDetailView> {
    return this.meetings.get(context, principal, meetingId);
  }

  @Put(':meetingId/rsvp')
  @RequireCapability('client_request.submit')
  async setRsvp(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('meetingId') meetingId: string,
    @Body() body: { readonly rsvp?: unknown },
  ): Promise<PortalMeetingView> {
    const rsvp = body?.rsvp;
    if (rsvp !== 'accepted' && rsvp !== 'declined') {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: 'rsvp', message: "must be 'accepted' or 'declined'" },
      ]);
    }
    return this.meetings.setRsvp(context, principal, meetingId, rsvp);
  }
}

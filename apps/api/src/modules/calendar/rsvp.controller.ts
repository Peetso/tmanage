import { Body, Controller, Get, Inject, Param, Put } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { MeetingRsvpResponse } from './rsvp.repository.js';
import { MEETING_RSVP_SERVICE } from './rsvp.service.js';
import type { MeetingRsvpService, MeetingRsvpView } from './rsvp.service.js';

/**
 * CAL meeting RSVP (x240). A member's own response to a meeting they can see: `accepted`, `declined`
 * or `tentative`. `GET .../rsvp` returns the summary (counts + the caller's own response) behind
 * `meeting.read`; `PUT .../rsvp` sets the caller's own response behind `meeting.write` and is
 * idempotent.
 *
 * Like every tenant-scoped controller here, it never reads `organizationId` from the body, a header,
 * or its own `:orgSlug` segment: it receives the `TenantContext` that `TenantContextGuard` built
 * from a membership row and passes it on. The meeting is named by the path and resolved
 * tenant-scoped in the service **before** the relation check and any write (the Known-trap order),
 * so a cross-tenant `meetingId` is a 404 with no write, never a 500. The response is always the
 * caller's own — the row is keyed on the principal's membership — so there is no way to answer for
 * another member.
 */

const RESPONSES: readonly MeetingRsvpResponse[] = ['accepted', 'declined', 'tentative'];

interface SetRsvpBody {
  readonly response?: unknown;
}

@Controller('v1/organizations/:orgSlug/meetings/:meetingId/rsvp')
export class MeetingRsvpController {
  constructor(@Inject(MEETING_RSVP_SERVICE) private readonly rsvps: MeetingRsvpService) {}

  @Get()
  @RequireCapability('meeting.read')
  async summary(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('meetingId') meetingId: string,
  ): Promise<MeetingRsvpView> {
    if (typeof meetingId !== 'string' || meetingId === '') {
      throw new ApiError(400, 'validation_failed', 'meetingId is required', [
        { field: 'meetingId', message: 'must be a non-empty string' },
      ]);
    }

    return this.rsvps.getSummary(context, principal, meetingId);
  }

  @Put()
  @RequireCapability('meeting.write')
  async setResponse(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('meetingId') meetingId: string,
    @Body() body: SetRsvpBody,
  ): Promise<MeetingRsvpView> {
    if (typeof meetingId !== 'string' || meetingId === '') {
      throw new ApiError(400, 'validation_failed', 'meetingId is required', [
        { field: 'meetingId', message: 'must be a non-empty string' },
      ]);
    }

    // An absent or unknown response is a malformed request (400): the fixed vocabulary is the
    // contract, and a value outside it never reaches the service, so no write happens.
    if (
      typeof body?.response !== 'string' ||
      !(RESPONSES as readonly string[]).includes(body.response)
    ) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: 'response', message: "must be 'accepted', 'declined' or 'tentative'" },
      ]);
    }

    return this.rsvps.setResponse(context, principal, {
      meetingId,
      response: body.response as MeetingRsvpResponse,
    });
  }
}

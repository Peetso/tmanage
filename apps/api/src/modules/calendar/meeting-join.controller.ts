import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type {
  MeetingAttendanceView,
  MeetingCallView,
  MeetingJoinService,
  MeetingJoinView,
} from './meeting-join.service.js';
import type { MeetingView } from './meetings.service.js';

/** 53-12: the token the calendar module provides `MeetingJoinService` under. */
export const MEETING_JOIN_SERVICE = Symbol('MEETING_JOIN_SERVICE');

const MAX_TITLE_LENGTH = 300;

/** `POST …/meetings/quick-room`: the project the ad-hoc meeting lives in, and an optional title. */
interface CreateQuickRoomBody {
  readonly projectId?: unknown;
  readonly title?: unknown;
}

function invalid(field: string, message: string): ApiError {
  return new ApiError(400, 'validation_failed', 'The request body is invalid', [
    { field, message },
  ]);
}

/**
 * 53-12 — Join, the call link, attendance and quick rooms for staff. The route guard asks the
 * coarse capability; the service resolves the meeting tenant-scoped, checks the project relation
 * and, for Join, that the caller is invited. Nothing here reads a tenant from the body.
 */
@Controller('v1/organizations/:orgSlug/meetings')
export class MeetingJoinController {
  constructor(@Inject(MEETING_JOIN_SERVICE) private readonly join: MeetingJoinService) {}

  @Get(':meetingId/call')
  @RequireCapability('meeting.read')
  async call(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('meetingId') meetingId: string,
  ): Promise<MeetingCallView> {
    return this.join.call(context, principal, meetingId);
  }

  @Put(':meetingId/call')
  @RequireCapability('meeting.write')
  async setCall(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('meetingId') meetingId: string,
    @Body() body: { readonly url?: unknown },
  ): Promise<MeetingCallView> {
    const url = body?.url;
    if (url !== null && typeof url !== 'string') throw invalid('url', 'must be a link or null');
    return this.join.setCall(context, principal, meetingId, url);
  }

  @Post(':meetingId/join')
  @RequireCapability('meeting.read')
  @HttpCode(200)
  async joinMeeting(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('meetingId') meetingId: string,
  ): Promise<MeetingJoinView> {
    return this.join.joinAsMember(context, principal, meetingId);
  }

  @Get(':meetingId/attendance')
  @RequireCapability('meeting.read')
  async attendance(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('meetingId') meetingId: string,
  ): Promise<MeetingAttendanceView> {
    return this.join.attendance(context, principal, meetingId);
  }

  @Put(':meetingId/attendance/:userId')
  @RequireCapability('meeting.write')
  async mark(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('meetingId') meetingId: string,
    @Param('userId') userId: string,
    @Body() body: { readonly status?: unknown },
  ): Promise<MeetingAttendanceView> {
    const status = body?.status;
    if (status !== 'present' && status !== 'absent') {
      throw invalid('status', "must be 'present' or 'absent'");
    }
    return this.join.mark(context, principal, meetingId, userId, status);
  }

  @Post(':meetingId/quick-room')
  @RequireCapability('meeting.write')
  @HttpCode(200)
  async startQuickRoom(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('meetingId') meetingId: string,
  ): Promise<MeetingCallView> {
    return this.join.startQuickRoom(context, principal, meetingId);
  }

  @Post('quick-room')
  @RequireCapability('meeting.write')
  async createQuickRoom(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: CreateQuickRoomBody,
  ): Promise<{ readonly meeting: MeetingView; readonly call: MeetingCallView }> {
    const projectId = body?.projectId;
    if (typeof projectId !== 'string' || projectId === '') {
      throw invalid('projectId', 'is required');
    }
    const rawTitle = typeof body?.title === 'string' ? body.title.trim() : '';
    if (rawTitle.length > MAX_TITLE_LENGTH) throw invalid('title', 'is too long');
    return this.join.createQuickRoom(context, principal, {
      projectId,
      title: rawTitle === '' ? 'Quick room' : rawTitle,
    });
  }
}

/**
 * 53-12 — the client portal's Join: only the client person's own meetings (their attendee row, on a
 * project still shared with their company). Joining is the client's own write about their own
 * attendance, so it takes `client_request.submit`, as the portal RSVP does.
 */
@Controller('v1/organizations/:orgSlug/portal/meetings')
export class PortalMeetingJoinController {
  constructor(@Inject(MEETING_JOIN_SERVICE) private readonly join: MeetingJoinService) {}

  @Get(':meetingId/call')
  @RequireCapability('client_projection.read')
  async call(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('meetingId') meetingId: string,
  ): Promise<MeetingCallView> {
    return this.join.clientCall(context, principal, meetingId);
  }

  @Post(':meetingId/join')
  @RequireCapability('client_request.submit')
  @HttpCode(200)
  async joinMeeting(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('meetingId') meetingId: string,
  ): Promise<MeetingJoinView> {
    return this.join.joinAsClient(context, principal, meetingId);
  }
}

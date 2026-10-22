import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { MEETING_ATTENDEES_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { AttendeeRsvp } from './meeting-attendees.repository.js';
import type {
  ClientAttendeeCandidateView,
  MeetingAttendeeView,
  MeetingAttendeesService,
  MeetingClientAttendeeView,
} from './meeting-attendees.service.js';

/**
 * CAL-01 / MTG-01 attendees + RSVP (x126). The calendar module's attendee endpoints: invite a
 * member to a meeting, list a meeting's attendees, and set an attendee's RSVP.
 *
 * Like every tenant-scoped controller here, it never reads `organizationId` from the body, a header,
 * or its own `:orgSlug` segment: it receives the `TenantContext` that `TenantContextGuard` built
 * from a membership row and passes it on. The meeting and the attendee are named by the path and
 * resolved tenant-scoped in the service **before** the relation check and any write (the Known-trap
 * order), so a cross-tenant `meetingId`/`attendeeId` is a 404 with no write, never a 500.
 */

const RSVPS: readonly AttendeeRsvp[] = ['invited', 'accepted', 'declined'];

interface InviteAttendeeBody {
  readonly userId?: unknown;
  /** BK5: a client person of the meeting's project, instead of `userId`. */
  readonly clientUserId?: unknown;
}

interface SetRsvpBody {
  readonly rsvp?: unknown;
}

@Controller('v1/organizations/:orgSlug/meetings/:meetingId/attendees')
export class MeetingAttendeesController {
  constructor(
    @Inject(MEETING_ATTENDEES_SERVICE) private readonly attendees: MeetingAttendeesService,
  ) {}

  @Get()
  @RequireCapability('meeting.read')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('meetingId') meetingId: string,
    @Query('after') after?: string,
    @Query('limit') limit?: string,
  ): Promise<{
    readonly attendees: readonly MeetingAttendeeView[];
    readonly clientAttendees: readonly MeetingClientAttendeeView[];
  }> {
    if (typeof meetingId !== 'string' || meetingId === '') {
      throw new ApiError(400, 'validation_failed', 'meetingId is required', [
        { field: 'meetingId', message: 'must be a non-empty string' },
      ]);
    }

    const parsedLimit = limit === undefined ? undefined : Number(limit);
    if (parsedLimit !== undefined && !Number.isSafeInteger(parsedLimit)) {
      throw new ApiError(400, 'validation_failed', 'limit must be an integer', [
        { field: 'limit', message: 'must be an integer' },
      ]);
    }

    const attendees = await this.attendees.listAttendees(context, principal, {
      meetingId,
      ...(after ? { after } : {}),
      ...(parsedLimit !== undefined ? { limit: parsedLimit } : {}),
    });
    // BK5: client people ride beside the members on the first page only (they are few).
    const clientAttendees = after
      ? []
      : await this.attendees.listClientAttendees(context, principal, meetingId);
    return { attendees, clientAttendees };
  }

  /** BK5: the client people of this meeting's project who may be added. */
  @Get('client-candidates')
  @RequireCapability('meeting.read')
  async clientCandidates(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('meetingId') meetingId: string,
  ): Promise<{ readonly candidates: readonly ClientAttendeeCandidateView[] }> {
    if (!meetingId) {
      throw new ApiError(400, 'validation_failed', 'meetingId is required', [
        { field: 'meetingId', message: 'must be a non-empty string' },
      ]);
    }
    return {
      candidates: await this.attendees.listClientCandidates(context, principal, meetingId),
    };
  }

  @Post()
  @RequireCapability('meeting.write')
  @HttpCode(201)
  async invite(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('meetingId') meetingId: string,
    @Body() body: InviteAttendeeBody,
  ): Promise<MeetingAttendeeView | MeetingClientAttendeeView> {
    // BK5: exactly one of `userId` (a member) or `clientUserId` (a client of this project).
    const clientUserId = typeof body?.clientUserId === 'string' ? body.clientUserId : undefined;
    if (body?.clientUserId !== undefined && body?.userId !== undefined) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: 'clientUserId', message: 'send either userId or clientUserId, not both' },
      ]);
    }
    if (clientUserId !== undefined && meetingId) {
      if (clientUserId === '') {
        throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
          { field: 'clientUserId', message: 'must be a non-empty string' },
        ]);
      }
      return this.attendees.inviteClient(context, principal, { meetingId, userId: clientUserId });
    }
    const userId = typeof body?.userId === 'string' ? body.userId : undefined;

    const details = [
      ...(meetingId ? [] : [{ field: 'meetingId', message: 'must be a non-empty string' }]),
      ...(userId ? [] : [{ field: 'userId', message: 'must be a non-empty string' }]),
    ];
    if (details.length > 0) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
    }
    // Narrowed by the `details.length` check above, which TypeScript cannot see through.
    if (!meetingId || !userId) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
    }

    return this.attendees.invite(context, principal, { meetingId, userId });
  }

  @Patch(':attendeeId')
  @RequireCapability('meeting.write')
  async setRsvp(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('meetingId') meetingId: string,
    @Param('attendeeId') attendeeId: string,
    @Body() body: SetRsvpBody,
  ): Promise<MeetingAttendeeView> {
    if (typeof meetingId !== 'string' || meetingId === '') {
      throw new ApiError(400, 'validation_failed', 'meetingId is required', [
        { field: 'meetingId', message: 'must be a non-empty string' },
      ]);
    }
    if (typeof attendeeId !== 'string' || attendeeId === '') {
      throw new ApiError(400, 'validation_failed', 'attendeeId is required', [
        { field: 'attendeeId', message: 'must be a non-empty string' },
      ]);
    }

    // An absent RSVP is a malformed request (400). A present value outside the fixed vocabulary is
    // an illegal RSVP — a 409, per the slice contract — and the service is never reached, so no
    // write happens.
    if (typeof body?.rsvp !== 'string' || body.rsvp === '') {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: 'rsvp', message: "must be 'invited', 'accepted' or 'declined'" },
      ]);
    }
    if (!(RSVPS as readonly string[]).includes(body.rsvp)) {
      throw new ApiError(
        409,
        'conflict',
        'That is not a valid RSVP',
        [{ field: 'rsvp', message: "must be 'invited', 'accepted' or 'declined'" }],
        'illegal_rsvp',
      );
    }

    return this.attendees.setRsvp(context, principal, {
      meetingId,
      attendeeId,
      rsvp: body.rsvp as AttendeeRsvp,
    });
  }

  /** Audit gap 8 (COL-06): remove an attendee. 204, or 404 for an attendee not on this meeting. */
  @Delete(':attendeeId')
  @RequireCapability('meeting.write')
  @HttpCode(204)
  async remove(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('meetingId') meetingId: string,
    @Param('attendeeId') attendeeId: string,
  ): Promise<void> {
    if (!meetingId || !attendeeId) {
      throw new ApiError(400, 'validation_failed', 'meetingId and attendeeId are required', [
        { field: meetingId ? 'attendeeId' : 'meetingId', message: 'must be a non-empty string' },
      ]);
    }
    await this.attendees.remove(context, principal, { meetingId, attendeeId });
  }
}

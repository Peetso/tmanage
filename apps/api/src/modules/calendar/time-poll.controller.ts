import { Body, Controller, Get, Inject, Param, Post, Put } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { MeetingTimePollVoteChoice, NewPollOption } from './time-poll.repository.js';
import { MEETING_TIME_POLL_SERVICE } from './time-poll.service.js';
import type { MeetingTimePollService, MeetingTimePollView } from './time-poll.service.js';

/**
 * CAL meeting time-option poll (x298). An organiser proposes several candidate time slots, invitees
 * vote yes/maybe/no on each, and the tally picks the time.
 *
 * - `POST .../time-poll` proposes slots (behind `meeting.write`; the service further requires the
 *   caller be the meeting's organiser);
 * - `GET .../time-poll` reads the poll (behind `meeting.read`);
 * - `PUT .../time-poll/options/:optionId/vote` casts the caller's own vote (behind `meeting.read`,
 *   any invitee), idempotently.
 *
 * Like every tenant-scoped controller here, it never reads `organizationId` from the body, a header,
 * or its own `:orgSlug` segment: it receives the `TenantContext` that `TenantContextGuard` built and
 * passes it on. The meeting — and, for a vote, the option — is named by the path and resolved
 * tenant-scoped in the service **before** the relation check and any write (the Known-trap order),
 * so a cross-tenant `meetingId` or `optionId` is a 404 with no write, never a 500. A vote row is
 * keyed on the principal's membership, so there is no way to vote for another member.
 */

const VOTE_CHOICES: readonly MeetingTimePollVoteChoice[] = ['yes', 'maybe', 'no'];

interface RawOption {
  readonly startsAt?: unknown;
  readonly endsAt?: unknown;
}

interface CreatePollBody {
  readonly options?: unknown;
}

interface VoteBody {
  readonly choice?: unknown;
}

/** Parse one candidate slot, throwing 400 for a missing/unparseable bound or an ill-ordered pair. */
function parseOption(raw: RawOption, index: number): NewPollOption {
  const startsAt = parseInstant(raw?.startsAt, `options[${index}].startsAt`);
  const endsAt = parseInstant(raw?.endsAt, `options[${index}].endsAt`);
  // A slot must be a forward interval — `endsAt <= startsAt` is a malformed request (400), so it
  // never reaches the service and nothing is inserted.
  if (endsAt.getTime() <= startsAt.getTime()) {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field: `options[${index}].endsAt`, message: 'must be after startsAt' },
    ]);
  }
  return { optionStart: startsAt, optionEnd: endsAt };
}

function parseInstant(value: unknown, field: string): Date {
  if (typeof value !== 'string' || value === '') {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field, message: 'must be an ISO-8601 instant' },
    ]);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field, message: 'must be a valid ISO-8601 instant' },
    ]);
  }
  return date;
}

@Controller('v1/organizations/:orgSlug/meetings/:meetingId/time-poll')
export class MeetingTimePollController {
  constructor(@Inject(MEETING_TIME_POLL_SERVICE) private readonly polls: MeetingTimePollService) {}

  @Get()
  @RequireCapability('meeting.read')
  async read(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('meetingId') meetingId: string,
  ): Promise<MeetingTimePollView> {
    requireMeetingId(meetingId);
    return this.polls.getPoll(context, principal, meetingId);
  }

  @Post()
  @RequireCapability('meeting.write')
  async create(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('meetingId') meetingId: string,
    @Body() body: CreatePollBody,
  ): Promise<MeetingTimePollView> {
    requireMeetingId(meetingId);

    // At least one option, and each a well-formed forward interval. An empty or non-array `options`
    // is a malformed request that never reaches the service.
    if (!Array.isArray(body?.options) || body.options.length === 0) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: 'options', message: 'must be a non-empty array of candidate slots' },
      ]);
    }
    const options = (body.options as RawOption[]).map((raw, index) => parseOption(raw, index));

    return this.polls.createPoll(context, principal, { meetingId, options });
  }

  @Put('options/:optionId/vote')
  @RequireCapability('meeting.read')
  async vote(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('meetingId') meetingId: string,
    @Param('optionId') optionId: string,
    @Body() body: VoteBody,
  ): Promise<MeetingTimePollView> {
    requireMeetingId(meetingId);
    if (typeof optionId !== 'string' || optionId === '') {
      throw new ApiError(400, 'validation_failed', 'optionId is required', [
        { field: 'optionId', message: 'must be a non-empty string' },
      ]);
    }

    // An absent or unknown choice is a malformed request (400): the fixed vocabulary is the
    // contract, and a value outside it never reaches the service, so no upsert happens.
    if (
      typeof body?.choice !== 'string' ||
      !(VOTE_CHOICES as readonly string[]).includes(body.choice)
    ) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: 'choice', message: "must be 'yes', 'maybe' or 'no'" },
      ]);
    }

    return this.polls.vote(context, principal, {
      meetingId,
      optionId,
      choice: body.choice as MeetingTimePollVoteChoice,
    });
  }
}

function requireMeetingId(meetingId: string): void {
  if (typeof meetingId !== 'string' || meetingId === '') {
    throw new ApiError(400, 'validation_failed', 'meetingId is required', [
      { field: 'meetingId', message: 'must be a non-empty string' },
    ]);
  }
}

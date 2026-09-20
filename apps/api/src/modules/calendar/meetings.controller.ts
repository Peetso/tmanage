import { Body, Controller, Get, HttpCode, Inject, Post, Query } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { MEETINGS_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { MeetingView, MeetingsService } from './meetings.service.js';

/**
 * CAL-01 / MTG-01 (x90). The first calendar endpoints: create a project meeting, and list a
 * project's meetings.
 *
 * Like every tenant-scoped controller here, it never reads `organizationId` from the body, a
 * header, or its own `:orgSlug` segment: it receives the `TenantContext` that
 * `TenantContextGuard` built from a membership row and passes it on. The body shapes carry no
 * tenant field, so there is nothing for a caller to supply and nothing for a handler to prefer
 * over the context.
 */

interface CreateMeetingBody {
  readonly projectId?: unknown;
  readonly title?: unknown;
  /** An ISO-8601 instant, e.g. `2026-10-01T14:00:00.000Z`. */
  readonly startsAt?: unknown;
  readonly agendaNote?: unknown;
}

/** `meetings.title` is `VARCHAR(300)`. */
const MAX_TITLE_LENGTH = 300;
/** `meetings.agenda_note` is `TEXT`; this is a form field, not a document. */
const MAX_AGENDA_LENGTH = 8_000;

@Controller('v1/organizations/:orgSlug/meetings')
export class MeetingsController {
  constructor(@Inject(MEETINGS_SERVICE) private readonly meetings: MeetingsService) {}

  @Get()
  @RequireCapability('meeting.read')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Query('projectId') projectId?: string,
    @Query('after') after?: string,
    @Query('limit') limit?: string,
  ): Promise<{ readonly meetings: readonly MeetingView[] }> {
    if (typeof projectId !== 'string' || projectId === '') {
      throw new ApiError(400, 'validation_failed', 'projectId is required', [
        { field: 'projectId', message: 'must be a non-empty string' },
      ]);
    }

    const parsedLimit = limit === undefined ? undefined : Number(limit);
    if (parsedLimit !== undefined && !Number.isSafeInteger(parsedLimit)) {
      throw new ApiError(400, 'validation_failed', 'limit must be an integer', [
        { field: 'limit', message: 'must be an integer' },
      ]);
    }

    return {
      meetings: await this.meetings.list(context, principal, {
        projectId,
        ...(after ? { after } : {}),
        ...(parsedLimit !== undefined ? { limit: parsedLimit } : {}),
      }),
    };
  }

  @Post()
  @RequireCapability('meeting.write')
  @HttpCode(201)
  async create(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: CreateMeetingBody,
  ): Promise<MeetingView> {
    const projectId = typeof body?.projectId === 'string' ? body.projectId : undefined;
    const title = typeof body?.title === 'string' ? body.title.trim() : undefined;
    const agendaNote =
      typeof body?.agendaNote === 'string' && body.agendaNote !== '' ? body.agendaNote : undefined;

    const details = [
      ...(projectId ? [] : [{ field: 'projectId', message: 'must be a non-empty string' }]),
      ...(title ? [] : [{ field: 'title', message: 'must be a non-empty string' }]),
      ...(title && title.length > MAX_TITLE_LENGTH
        ? [{ field: 'title', message: `must be ${MAX_TITLE_LENGTH} characters or fewer` }]
        : []),
      ...(agendaNote !== undefined && agendaNote.length > MAX_AGENDA_LENGTH
        ? [{ field: 'agendaNote', message: `must be ${MAX_AGENDA_LENGTH} characters or fewer` }]
        : []),
    ];

    const startsAt = parseInstant(body?.startsAt, details);

    if (details.length > 0) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
    }
    // Narrowed by the `details.length` check above, which TypeScript cannot see through: the
    // guard is on a separate array rather than on these bindings.
    if (!projectId || !title || !startsAt) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
    }

    return this.meetings.create(context, principal, {
      projectId,
      title,
      startsAt,
      ...(agendaNote === undefined ? {} : { agendaNote }),
    });
  }
}

/**
 * Validate an ISO-8601 instant and return it as a `Date`, or add a field error.
 *
 * A meeting's start is a point in time, not a calendar date (unlike `projects.forecast_at`), so
 * it is parsed to a `Date` and stored as a UTC instant. `undefined` for an absent or rejected
 * value alike; the caller reads `details` to tell them apart.
 */
function parseInstant(
  raw: unknown,
  details: { field: string; message: string }[],
): Date | undefined {
  if (raw === undefined || raw === null || raw === '') {
    details.push({ field: 'startsAt', message: 'is required' });
    return undefined;
  }
  if (typeof raw !== 'string') {
    details.push({ field: 'startsAt', message: 'must be an ISO-8601 date-time string' });
    return undefined;
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    details.push({ field: 'startsAt', message: 'must be an ISO-8601 date-time string' });
    return undefined;
  }
  return parsed;
}

import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { MEETING_OCCURRENCE_OVERRIDE_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { MEETING_OCCURRENCE_OVERRIDE_STATUSES } from './occurrence-override.repository.js';
import type { MeetingOccurrenceOverrideStatus } from './occurrence-override.repository.js';
import type {
  OccurrenceOverrideService,
  OccurrenceOverrideView,
} from './occurrence-override.service.js';

/**
 * CAL per-occurrence override (x213). The per-occurrence exception endpoints on a recurring series:
 * read, upsert, or remove the override for one occurrence date. Nested under the series' occurrences
 * path with a `:date` segment, so it never collides with the series' own bare
 * `GET :seriesId/occurrences` expand (that route has no `:date`).
 *
 * Like every tenant-scoped controller here it never reads `organizationId` from the body, a header or
 * its own `:orgSlug` segment: it receives the `TenantContext` that `TenantContextGuard` built and
 * passes it on. The series is resolved tenant-scoped in the service (the Known-trap order): a
 * cross-tenant `:seriesId` is a 404 before any read of its overrides or any write.
 */

/** `meeting_occurrence_overrides.new_title` is `VARCHAR(300)`, like the series title. */
const MAX_TITLE_LENGTH = 300;
const STATUSES: readonly MeetingOccurrenceOverrideStatus[] = MEETING_OCCURRENCE_OVERRIDE_STATUSES;
/** A calendar date on the wire: `YYYY-MM-DD`, the 0012 convention. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** A time-of-day on the wire: `HH:MM` or `HH:MM:SS` (24-hour). */
const ISO_TIME = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

interface UpsertOverrideBody {
  readonly status?: unknown;
  readonly newDate?: unknown;
  readonly newStartTime?: unknown;
  readonly newTitle?: unknown;
}

@Controller('v1/organizations/:orgSlug/meeting-series/:seriesId/occurrences')
export class OccurrenceOverrideController {
  constructor(
    @Inject(MEETING_OCCURRENCE_OVERRIDE_SERVICE)
    private readonly overrides: OccurrenceOverrideService,
  ) {}

  /** Read the override for one occurrence date (behind `meeting.read`), or 404. */
  @Get(':date')
  @RequireCapability('meeting.read')
  async get(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('seriesId') seriesId: string,
    @Param('date') date: string,
  ): Promise<OccurrenceOverrideView> {
    this.requireIsoDate(date);
    return this.overrides.get(context, principal, { seriesId, occurrenceDate: date });
  }

  /**
   * Upsert the override for one occurrence date (behind `meeting.write`).
   *
   * The body carries `status` and, for a `moved` override, at least one of `newDate`/`newStartTime`/
   * `newTitle`; a `cancelled` override carries none of them. Field coherence is validated here; that
   * `:date` is a real occurrence of the series is validated in the service against the series rule.
   */
  @Post(':date')
  @RequireCapability('meeting.write')
  @HttpCode(200)
  async upsert(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('seriesId') seriesId: string,
    @Param('date') date: string,
    @Body() body: UpsertOverrideBody,
  ): Promise<OccurrenceOverrideView> {
    this.requireIsoDate(date);

    const status =
      typeof body?.status === 'string' && (STATUSES as readonly string[]).includes(body.status)
        ? (body.status as MeetingOccurrenceOverrideStatus)
        : undefined;

    const newDate =
      body?.newDate === undefined || body?.newDate === null
        ? null
        : typeof body.newDate === 'string' && ISO_DATE.test(body.newDate)
          ? body.newDate
          : undefined;
    const rawTime =
      body?.newStartTime === undefined || body?.newStartTime === null
        ? null
        : typeof body.newStartTime === 'string' && ISO_TIME.test(body.newStartTime)
          ? body.newStartTime
          : undefined;
    const newTitle =
      body?.newTitle === undefined || body?.newTitle === null
        ? null
        : typeof body.newTitle === 'string'
          ? body.newTitle.trim()
          : undefined;

    const details = [
      ...(status ? [] : [{ field: 'status', message: "must be 'moved' or 'cancelled'" }]),
      ...(newDate === undefined
        ? [{ field: 'newDate', message: 'must be a YYYY-MM-DD date' }]
        : []),
      ...(rawTime === undefined
        ? [{ field: 'newStartTime', message: 'must be an HH:MM or HH:MM:SS time' }]
        : []),
      ...(newTitle === undefined
        ? [{ field: 'newTitle', message: 'must be a string' }]
        : newTitle !== null && (newTitle.length === 0 || newTitle.length > MAX_TITLE_LENGTH)
          ? [{ field: 'newTitle', message: `must be 1 to ${MAX_TITLE_LENGTH} characters` }]
          : []),
    ];
    if (details.length > 0) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
    }
    // Narrowed by the check above, which TypeScript cannot see through.
    if (
      status === undefined ||
      newDate === undefined ||
      rawTime === undefined ||
      newTitle === undefined
    ) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
    }

    // Coherence: a cancelled occurrence carries no move fields; a moved one carries at least one.
    if (status === 'cancelled' && (newDate !== null || rawTime !== null || newTitle !== null)) {
      throw new ApiError(
        400,
        'validation_failed',
        'A cancelled occurrence carries no move fields',
        [
          {
            field: 'status',
            message: 'cancelled must not carry newDate, newStartTime or newTitle',
          },
        ],
      );
    }
    if (status === 'moved' && newDate === null && rawTime === null && newTitle === null) {
      throw new ApiError(400, 'validation_failed', 'A moved occurrence must change something', [
        {
          field: 'status',
          message: 'moved must carry at least one of newDate, newStartTime or newTitle',
        },
      ]);
    }

    // Normalise HH:MM to HH:MM:SS for the TIME column so the stored value round-trips exactly.
    const newStartTime = rawTime === null ? null : rawTime.length === 5 ? `${rawTime}:00` : rawTime;

    return this.overrides.upsert(context, principal, {
      seriesId,
      occurrenceDate: date,
      status,
      newDate,
      newStartTime,
      newTitle,
    });
  }

  /** Remove the override for one occurrence date (behind `meeting.write`), restoring the base rule. */
  @Delete(':date')
  @RequireCapability('meeting.write')
  @HttpCode(204)
  async remove(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('seriesId') seriesId: string,
    @Param('date') date: string,
  ): Promise<void> {
    this.requireIsoDate(date);
    await this.overrides.remove(context, principal, { seriesId, occurrenceDate: date });
  }

  /** A malformed `:date` is a 400 before the service runs. */
  private requireIsoDate(date: string): void {
    if (typeof date !== 'string' || !ISO_DATE.test(date)) {
      throw new ApiError(400, 'validation_failed', 'The occurrence date is invalid', [
        { field: 'date', message: 'must be a YYYY-MM-DD date' },
      ]);
    }
  }
}

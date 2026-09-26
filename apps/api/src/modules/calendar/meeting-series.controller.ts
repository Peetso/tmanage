import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { MEETING_SERIES_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { MEETING_SERIES_FREQS } from './meeting-series.repository.js';
import type { MeetingSeriesFreq } from './meeting-series.repository.js';
import { MAX_WINDOW_DAYS, isWindowValid } from './meeting-series.expand.js';
import type {
  MeetingSeriesOccurrences,
  MeetingSeriesService,
  MeetingSeriesView,
} from './meeting-series.service.js';

/**
 * CAL recurrence (x129). The meeting-series endpoints: create a series, list a tenant's series, and
 * expand one series' occurrences in a bounded window.
 *
 * Like every tenant-scoped controller here it never reads `organizationId` from the body, a header or
 * its own `:orgSlug` segment: it receives the `TenantContext` that `TenantContextGuard` built and
 * passes it on. The body shapes carry no tenant field. A series is org-scoped — it names no project —
 * so there is no `projectId` to validate; the object authorization is the capability alone, made in
 * the service.
 */

/** `meeting_series.title` is `VARCHAR(300)`. */
const MAX_TITLE_LENGTH = 300;
const FREQS: readonly MeetingSeriesFreq[] = MEETING_SERIES_FREQS;
/** A calendar date on the wire: `YYYY-MM-DD`, the 0012 convention. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

interface CreateMeetingSeriesBody {
  readonly title?: unknown;
  readonly freq?: unknown;
  readonly interval?: unknown;
  readonly until?: unknown;
}

@Controller('v1/organizations/:orgSlug/meeting-series')
export class MeetingSeriesController {
  constructor(@Inject(MEETING_SERIES_SERVICE) private readonly series: MeetingSeriesService) {}

  @Get()
  @RequireCapability('meeting.read')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Query('after') after?: string,
    @Query('limit') limit?: string,
  ): Promise<{ readonly series: readonly MeetingSeriesView[] }> {
    const parsedLimit = limit === undefined ? undefined : Number(limit);
    if (parsedLimit !== undefined && !Number.isSafeInteger(parsedLimit)) {
      throw new ApiError(400, 'validation_failed', 'limit must be an integer', [
        { field: 'limit', message: 'must be an integer' },
      ]);
    }

    return {
      series: await this.series.list(context, principal, {
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
    @Body() body: CreateMeetingSeriesBody,
  ): Promise<MeetingSeriesView> {
    const title = typeof body?.title === 'string' ? body.title.trim() : undefined;
    const freq =
      typeof body?.freq === 'string' && (FREQS as readonly string[]).includes(body.freq)
        ? (body.freq as MeetingSeriesFreq)
        : undefined;
    const interval = typeof body?.interval === 'number' ? body.interval : undefined;
    const until =
      body?.until === undefined || body?.until === null
        ? null
        : typeof body.until === 'string' && ISO_DATE.test(body.until)
          ? body.until
          : undefined;

    const details = [
      ...(title ? [] : [{ field: 'title', message: 'must be a non-empty string' }]),
      ...(title && title.length > MAX_TITLE_LENGTH
        ? [{ field: 'title', message: `must be ${MAX_TITLE_LENGTH} characters or fewer` }]
        : []),
      ...(freq ? [] : [{ field: 'freq', message: "must be 'daily', 'weekly' or 'monthly'" }]),
      ...(interval !== undefined && Number.isSafeInteger(interval) && interval >= 1
        ? []
        : [{ field: 'interval', message: 'must be a positive integer' }]),
      ...(until === undefined ? [{ field: 'until', message: 'must be a YYYY-MM-DD date' }] : []),
    ];

    if (details.length > 0) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
    }
    // Narrowed by the `details.length` check above, which TypeScript cannot see through.
    if (!title || !freq || interval === undefined) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
    }

    return this.series.create(context, principal, { title, freq, interval, until });
  }

  /**
   * Expand one series' occurrences in `[from, to]`. The window is required and bounded to
   * {@link MAX_WINDOW_DAYS} days here (a wider or malformed one is a 400) before the service runs, so
   * the expansion is over a validated window and can never be driven into a long walk. The series is
   * resolved tenant-scoped in the service (the Known-trap order): a cross-tenant `seriesId` is a 404
   * with no read of another tenant's rule.
   */
  @Get(':seriesId/occurrences')
  @RequireCapability('meeting.read')
  async occurrences(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('seriesId') seriesId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<MeetingSeriesOccurrences> {
    const details = [
      ...(seriesId ? [] : [{ field: 'seriesId', message: 'must be a non-empty string' }]),
      ...(typeof from === 'string' && ISO_DATE.test(from)
        ? []
        : [{ field: 'from', message: 'must be a YYYY-MM-DD date' }]),
      ...(typeof to === 'string' && ISO_DATE.test(to)
        ? []
        : [{ field: 'to', message: 'must be a YYYY-MM-DD date' }]),
    ];
    if (details.length > 0) {
      throw new ApiError(400, 'validation_failed', 'The window is invalid', details);
    }
    // Narrowed by the check above.
    if (!seriesId || from === undefined || to === undefined) {
      throw new ApiError(400, 'validation_failed', 'The window is invalid', details);
    }
    if (!isWindowValid(from, to)) {
      throw new ApiError(400, 'validation_failed', 'The window is invalid', [
        {
          field: 'to',
          message: `must be on or after 'from' and within ${MAX_WINDOW_DAYS} days of it`,
        },
      ]);
    }

    return this.series.occurrences(context, principal, { seriesId, from, to });
  }
}

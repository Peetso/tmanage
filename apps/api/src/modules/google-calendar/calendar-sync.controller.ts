import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Optional,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
  StreamableFile,
} from '@nestjs/common';
import { Ctx, NoTenant, Public, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { AUDIT_SERVICE } from '../../common/http/tokens.js';
import { requireRequestState } from '../../common/http/request-state.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { AuditService } from '../audit/audit.service.js';
import { Throttle } from '../rate-limits/throttle-policies.js';
import { MICROSOFT_CALENDAR_SERVICE } from '../microsoft-calendar/microsoft-calendar.controller.js';
import type { MicrosoftCalendarService } from '../microsoft-calendar/microsoft-calendar.service.js';
import type { MicrosoftCalendarStatusView } from '../microsoft-calendar/microsoft-calendar.service.js';
import type {
  CalendarConnectionStatusView,
  GoogleCalendarService,
} from './google-calendar.service.js';
import { graphValidationToken } from './calendar-push.js';
import type {
  CalendarFeedCreatedView,
  CalendarFeedService,
  CalendarFeedView,
} from './calendar-sync.service.js';
import type { CalendarPushReceiver } from './calendar-sync.service.js';
import type { CalendarSyncExtras } from './calendar-sync-extras.js';

/**
 * 53-14 — calendar sync's HTTP surface.
 *
 * Signed in, the caller's own settings only (no route names another person):
 * - `PUT    …/calendar-sync/:provider/due-date-mirror` `{enabled}` — the due-date mirror opt-in
 *   for the caller's own Google or Outlook connection; answers that connection's status.
 * - `GET    …/calendar-sync/feed` — whether the caller has a feed address (never the address).
 * - `POST   …/calendar-sync/feed` — create or replace it; the address is shown this once.
 * - `DELETE …/calendar-sync/feed` — turn it off.
 *
 * Signed out, each behind its own budget:
 * - `POST /v1/public/calendar-push/google` and `/microsoft` — provider push notifications,
 *   verified against the stored channel secret before one connection is pulled.
 * - `GET  /v1/public/calendar-feeds/:token/tmanage.ics` — the read-only ICS feed.
 */

/** The same registered symbol as `GOOGLE_CALENDAR_SERVICE` (that file registers this one). */
export const GOOGLE_CALENDAR_SERVICE_TOKEN = Symbol.for('tmanage.GoogleCalendarService');
export const CALENDAR_FEED_SERVICE = Symbol.for('tmanage.CalendarFeedService');
export const CALENDAR_PUSH_RECEIVER = Symbol.for('tmanage.CalendarPushReceiver');
export const CALENDAR_SYNC_EXTRAS = Symbol.for('tmanage.CalendarSyncExtras');

const PUSH_LIMITS = { perMinute: 600, perHour: 20_000, key: 'ip', onStoreError: 'open' } as const;
const FEED_LIMITS = { perMinute: 120, perHour: 3_000, key: 'ip', onStoreError: 'open' } as const;

function invalid(field: string, message: string): ApiError {
  return new ApiError(400, 'validation_failed', 'The request is invalid', [{ field, message }]);
}

/** The shared body rule for the mirror opt-in: exactly `{ enabled: boolean }`. */
export function parseMirrorBody(body: unknown): boolean {
  const enabled = (body as { enabled?: unknown } | null)?.enabled;
  if (typeof enabled !== 'boolean') throw invalid('enabled', 'must be true or false');
  return enabled;
}

@Controller('v1/organizations/:orgSlug/calendar-sync')
export class CalendarSyncSettingsController {
  constructor(
    @Inject(GOOGLE_CALENDAR_SERVICE_TOKEN) private readonly google: GoogleCalendarService,
    @Inject(CALENDAR_FEED_SERVICE) private readonly feeds: CalendarFeedService,
    @Inject(CALENDAR_SYNC_EXTRAS) private readonly extras: CalendarSyncExtras,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Optional()
    @Inject(MICROSOFT_CALENDAR_SERVICE)
    private readonly microsoft?: MicrosoftCalendarService,
  ) {}

  @Put(':provider/due-date-mirror')
  @RequireCapability('meeting.write')
  async setMirror(
    @Ctx() context: TenantContext,
    @Param('provider') provider: string,
    @Body() body: unknown,
  ): Promise<CalendarConnectionStatusView | MicrosoftCalendarStatusView> {
    const enabled = parseMirrorBody(body);
    if (provider === 'google') {
      await this.extras.setMirror(context, this.audit, 'google', enabled);
      return this.google.status(context);
    }
    if (provider === 'microsoft' && this.microsoft) {
      await this.extras.setMirror(context, this.audit, 'microsoft', enabled);
      return this.microsoft.status(context);
    }
    throw invalid('provider', 'must be google or microsoft');
  }

  @Get('feed')
  @RequireCapability('meeting.read')
  feed(@Ctx() context: TenantContext): Promise<CalendarFeedView> {
    return this.feeds.status(context);
  }

  @Post('feed')
  @RequireCapability('meeting.read')
  @HttpCode(200)
  rotateFeed(@Ctx() context: TenantContext): Promise<CalendarFeedCreatedView> {
    return this.feeds.rotate(context);
  }

  @Delete('feed')
  @RequireCapability('meeting.read')
  revokeFeed(@Ctx() context: TenantContext): Promise<CalendarFeedView> {
    return this.feeds.revoke(context);
  }
}

interface PublicRequest {
  readonly headers: Record<string, string | string[] | undefined>;
}

interface PublicReply {
  status(code: number): unknown;
  header(name: string, value: string): unknown;
}

@Controller('v1/public/calendar-push')
export class CalendarPushController {
  constructor(@Inject(CALENDAR_PUSH_RECEIVER) private readonly receiver: CalendarPushReceiver) {}

  @Post('google')
  @Public()
  @NoTenant()
  @Throttle('calendar_push', PUSH_LIMITS)
  async google(
    @Req() request: PublicRequest,
    @Res({ passthrough: true }) reply: PublicReply,
  ): Promise<void> {
    reply.status(
      await this.receiver.google(request.headers, requireRequestState(request).correlationId),
    );
  }

  /** Graph first proves the address with `?validationToken=…`, echoed as plain text. */
  @Post('microsoft')
  @Public()
  @NoTenant()
  @Throttle('calendar_push', PUSH_LIMITS)
  async microsoft(
    @Req() request: PublicRequest,
    @Query('validationToken') validationToken: unknown,
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: PublicReply,
  ): Promise<StreamableFile | undefined> {
    if (validationToken !== undefined) {
      const echo = graphValidationToken(validationToken);
      reply.header('x-content-type-options', 'nosniff');
      if (!echo) {
        reply.status(400);
        return undefined;
      }
      // Bytes, not a JSON value: the response interceptors leave a StreamableFile alone.
      reply.header('content-type', 'text/plain; charset=utf-8');
      reply.status(200);
      return new StreamableFile(Buffer.from(echo, 'utf8'), { type: 'text/plain; charset=utf-8' });
    }
    reply.status(await this.receiver.microsoft(body, requireRequestState(request).correlationId));
    return undefined;
  }
}

@Controller('v1/public/calendar-feeds')
export class CalendarFeedController {
  constructor(@Inject(CALENDAR_FEED_SERVICE) private readonly feeds: CalendarFeedService) {}

  @Get(':token/tmanage.ics')
  @Public()
  @NoTenant()
  @Throttle('calendar_feed', FEED_LIMITS)
  async feed(
    @Param('token') token: string,
    @Req() request: PublicRequest,
    @Res({ passthrough: true }) reply: PublicReply,
  ): Promise<StreamableFile> {
    const document = await this.feeds.render(token, requireRequestState(request).correlationId);
    if (document === null) throw new ApiError(404, 'not_found', 'No such calendar feed');
    const body = Buffer.from(document, 'utf8');
    reply.header('content-type', 'text/calendar; charset=utf-8');
    reply.header('content-length', String(body.byteLength));
    reply.header('content-disposition', 'inline; filename="tmanage.ics"');
    reply.header('x-content-type-options', 'nosniff');
    reply.header('cache-control', 'private, no-store');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('x-robots-tag', 'noindex, nofollow');
    return new StreamableFile(body, { type: 'text/calendar; charset=utf-8' });
  }
}

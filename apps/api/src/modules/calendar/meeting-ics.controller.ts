import { Controller, Get, Inject, Param, Res, StreamableFile } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { MEETINGS_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { MeetingsService } from './meetings.service.js';
import { serializeMeetingIcs } from './meeting-ics.js';

/**
 * CAL — ICS export (x128). The meeting's calendar download.
 *
 * `GET …/meetings/:meetingId/ics` renders one meeting as a read-only RFC-5545 `text/calendar`
 * document behind `meeting.read`. It never mutates — it is a `GET`, carries no CSRF token and
 * needs none (the session cookie and the tenant guard's membership resolution are the whole
 * authentication, re-done on every request).
 *
 * The Known-trap order lives in {@link MeetingsService.get}: the meeting is resolved
 * **tenant-scoped first**, so a cross-tenant or unknown `meetingId` is a 404 (never a 500), and a
 * caller who may not read that project's meetings gets the same 404 rather than a 403 that would
 * confirm the meeting exists. The coarse `meeting.read` ceiling is the route guard's; a caller
 * without it never reaches this handler (403).
 *
 * The response is a {@link StreamableFile} so Nest stays in its own response mode — the JSON
 * interceptors and the exception filter still shape everything that is not the bytes — exactly as
 * the file-download door does. The headers mirror that door's safe-download posture: an
 * `attachment` disposition with a fixed-shape filename, `nosniff`, and a private, no-store cache.
 */
@Controller('v1/organizations/:orgSlug/meetings')
export class MeetingIcsController {
  constructor(@Inject(MEETINGS_SERVICE) private readonly meetings: MeetingsService) {}

  /** The meetings table carries only a start, so the event's end is the start plus this default. */
  private static readonly DEFAULT_DURATION_MS = 60 * 60 * 1000;

  @Get(':meetingId/ics')
  @RequireCapability('meeting.read')
  async ics(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('meetingId') meetingId: string,
    @Res({ passthrough: true }) reply: { header(name: string, value: string): unknown },
  ): Promise<StreamableFile> {
    // Resolved tenant-scoped and relation-checked before anything is rendered (the Known trap).
    const meeting = await this.meetings.get(context, principal, meetingId);

    const startsAt = new Date(meeting.startsAt);
    const document = serializeMeetingIcs({
      uid: meeting.id,
      summary: meeting.title,
      startsAt,
      endsAt: new Date(startsAt.getTime() + MeetingIcsController.DEFAULT_DURATION_MS),
      stamp: new Date(),
    });

    const body = Buffer.from(document, 'utf8');
    // A fixed-shape filename from the (UUID) id — no tenant data, no user text, so it cannot carry
    // a CR/LF that would split the header or a quote that would end the parameter.
    const fileName = `meeting-${meeting.id.replace(/[^A-Za-z0-9_-]/g, '')}.ics`;
    reply.header('content-type', 'text/calendar; charset=utf-8');
    reply.header('content-length', String(body.byteLength));
    reply.header('content-disposition', `attachment; filename="${fileName}"`);
    reply.header('x-content-type-options', 'nosniff');
    reply.header('cache-control', 'private, no-store');

    return new StreamableFile(body, { type: 'text/calendar; charset=utf-8' });
  }
}

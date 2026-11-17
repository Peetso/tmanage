import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Module,
  Param,
  Post,
  Query,
  Redirect,
  Req,
  Res,
} from '@nestjs/common';
import { providerErrorReason } from '../platform-admin/connect-setup/connect-setup.js';
import type { DynamicModule, Provider } from '@nestjs/common';
import { Ctx, NoTenant, Public, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { API_CONFIG, AUDIT_SERVICE, TENANT_DATABASE } from '../../common/http/tokens.js';
import type { ApiConfig } from '../../common/http/api-config.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { AuditService } from '../audit/audit.service.js';
import { tokenVaultFromEnv } from '../connectors/token-vault.js';
import { expireCookie, readCookie, serializeCookie } from '../identity/session-token.js';
import { CALENDAR_SYNC } from '../calendar/calendar-sync.port.js';
import { combineCalendarSync } from '../calendar/calendar-provider.js';
import { oneDriveConfigFrom } from '../onedrive/onedrive.graph.js';
import { MICROSOFT_CALENDAR_SERVICE } from '../microsoft-calendar/microsoft-calendar.controller.js';
import type { MicrosoftCalendarService } from '../microsoft-calendar/microsoft-calendar.service.js';
import {
  GCAL_COOKIE_PATH,
  GCAL_FLOW_COOKIE,
  GCAL_FLOW_TTL_SECONDS,
  calendarConfigFrom,
  createCalendarTransport,
  openCalendarFlow,
  sealCalendarFlow,
  type CalendarTransport,
} from './google-calendar.google.js';
import {
  GoogleCalendarService,
  type CalendarConnectionStatusView,
  type CalendarTeamView,
} from './google-calendar.service.js';
import { CALENDAR_SYNC_JOB, CalendarSyncJob, calendarSyncJobEnabled } from './calendar-sync.job.js';
import { DEFAULT_CALENDAR_SYNC_JOB_OPTIONS } from './calendar-sync.job.js';
import { GoogleCalendarRepository } from './google-calendar.repository.js';
import { CalendarSyncExtras } from './calendar-sync-extras.js';
import { CalendarFeedService, CalendarPushReceiver } from './calendar-sync.service.js';
import {
  CALENDAR_FEED_SERVICE,
  CALENDAR_PUSH_RECEIVER,
  CALENDAR_SYNC_EXTRAS,
  CalendarFeedController,
  CalendarPushController,
  CalendarSyncSettingsController,
} from './calendar-sync.controller.js';

/**
 * Google Calendar + Meet for meetings (0237) — the HTTP surface. Every route acts on the CALLER'S
 * OWN connection: there is no route that names another person.
 *
 * - `GET    …/integrations/google-calendar` — the caller's Connected apps card.
 * - `POST   …/integrations/google-calendar/connect` — `{url}` for Google's consent screen; sets the
 *   signed flow cookie (state + PKCE verifier) bound to this person and organization.
 * - `GET    /v1/integrations/google-calendar/callback` — Google's redirect; forwards `code` and
 *   `state` in the URL fragment to Connected apps, which completes under the person's session.
 * - `POST   …/integrations/google-calendar/complete` — `{code, state}`: exchange, encrypt, save.
 * - `DELETE …/integrations/google-calendar` — disconnect (revoke, wipe the token).
 *
 * `meeting.read` to see the card, `meeting.write` to connect — the people who can schedule meetings.
 */

export const GOOGLE_CALENDAR_SERVICE = Symbol.for('tmanage.GoogleCalendarService');
const GOOGLE_CALENDAR_OPTIONS = Symbol.for('tmanage.GoogleCalendarOptions');

interface CalendarHttpOptions {
  readonly sessionSecret: string;
  readonly secureCookies: boolean;
  readonly webPublicUrl: string;
}

interface RequestLike {
  readonly headers: Record<string, string | string[] | undefined>;
}

interface ReplyLike {
  header(name: string, value: string | readonly string[]): unknown;
}

function cookieHeader(request: RequestLike): string | undefined {
  const raw = request.headers['cookie'];
  return Array.isArray(raw) ? raw.join('; ') : raw;
}

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

@Controller('v1/organizations/:orgSlug/integrations/google-calendar')
export class GoogleCalendarConnectionController {
  constructor(
    @Inject(GOOGLE_CALENDAR_SERVICE) private readonly calendar: GoogleCalendarService,
    @Inject(GOOGLE_CALENDAR_OPTIONS) private readonly options: CalendarHttpOptions,
  ) {}

  @Get()
  @RequireCapability('meeting.read')
  async status(@Ctx() context: TenantContext): Promise<CalendarConnectionStatusView> {
    return this.calendar.status(context);
  }

  /** Settings > Calendar connections, "Your team's calendars": owners only. */
  @Get('team')
  @RequireCapability('org.manage')
  async team(@Ctx() context: TenantContext): Promise<CalendarTeamView> {
    return this.calendar.team(context);
  }

  @Post('connect')
  @RequireCapability('meeting.write')
  @HttpCode(200)
  connect(
    @Ctx() context: TenantContext,
    @Param('orgSlug') orgSlug: string,
    @Res({ passthrough: true }) reply: ReplyLike,
  ): { readonly url: string } {
    if (!SLUG_PATTERN.test(orgSlug)) {
      throw new ApiError(400, 'validation_failed', 'The request is invalid', [
        { field: 'orgSlug', message: 'is not a workspace address' },
      ]);
    }
    const { url, flow } = this.calendar.startConnect(context, orgSlug);
    reply.header(
      'set-cookie',
      serializeCookie(GCAL_FLOW_COOKIE, sealCalendarFlow(flow, this.options.sessionSecret), {
        path: GCAL_COOKIE_PATH,
        maxAgeSeconds: GCAL_FLOW_TTL_SECONDS,
        // `Lax`: the cookie must survive the top-level return from Google.
        sameSite: 'Lax',
        secure: this.options.secureCookies,
      }),
    );
    return { url };
  }

  @Post('complete')
  @RequireCapability('meeting.write')
  @HttpCode(200)
  async complete(
    @Ctx() context: TenantContext,
    @Body() body: { readonly code?: unknown; readonly state?: unknown },
    @Req() request: RequestLike,
    @Res({ passthrough: true }) reply: ReplyLike,
  ): Promise<CalendarConnectionStatusView> {
    const flow = openCalendarFlow(
      readCookie(cookieHeader(request), GCAL_FLOW_COOKIE),
      this.options.sessionSecret,
    );
    // The flow is single-use whatever happens next.
    reply.header(
      'set-cookie',
      expireCookie(GCAL_FLOW_COOKIE, {
        path: GCAL_COOKIE_PATH,
        sameSite: 'Lax',
        secure: this.options.secureCookies,
      }),
    );
    return this.calendar.completeConnect(context, flow, { code: body?.code, state: body?.state });
  }

  @Delete()
  @RequireCapability('meeting.read')
  async disconnect(@Ctx() context: TenantContext): Promise<CalendarConnectionStatusView> {
    return this.calendar.disconnect(context);
  }
}

/**
 * Google's redirect after consent. Public and tenant-less because Google makes this request; it
 * only forwards. The organization comes from the signed flow cookie, and the code travels on in
 * the fragment (never sent to a server or a Referer).
 */
@Controller('v1/integrations/google-calendar')
export class GoogleCalendarCallbackController {
  constructor(@Inject(GOOGLE_CALENDAR_OPTIONS) private readonly options: CalendarHttpOptions) {}

  @Get('callback')
  @Public()
  @NoTenant()
  @Redirect()
  callback(
    @Query('code') code: unknown,
    @Query('state') state: unknown,
    @Req() request: RequestLike,
    @Query('error') error?: unknown,
  ): { readonly url: string; readonly statusCode: number } {
    return {
      url: calendarCallbackTarget(this.options, cookieHeader(request), code, state, error),
      statusCode: 302,
    };
  }
}

/** Where the callback sends the browser. Pure, so the forwarding rule is provable. */
export function calendarCallbackTarget(
  options: Pick<CalendarHttpOptions, 'sessionSecret' | 'webPublicUrl'>,
  cookies: string | undefined,
  code: unknown,
  state: unknown,
  error?: unknown,
): string {
  const base = options.webPublicUrl.replace(/\/+$/, '');
  const flow = openCalendarFlow(readCookie(cookies, GCAL_FLOW_COOKIE), options.sessionSecret);
  if (!flow || !SLUG_PATTERN.test(flow.organizationSlug)) return `${base}/`;
  const screen = `${base}/${flow.organizationSlug}/settings/connected-apps`;
  if (typeof code !== 'string' || typeof state !== 'string' || code.length > 2048) {
    // R37: a provider error we explain travels on as `reason`, so the card can say why.
    const reason = providerErrorReason(error);
    return reason ? `${screen}#gcal=error&reason=${reason}` : `${screen}#gcal=error`;
  }
  return `${screen}#${new URLSearchParams({ gcal: 'complete', code, state }).toString()}`;
}

/**
 * Always registered and global: it provides the {@link CALENDAR_SYNC} port the meetings services
 * call after a commit. Without a Google client in the environment the routes answer "not
 * configured" and every push/pull is a no-op, so meetings stay TManage-only.
 */
@Module({})
export class GoogleCalendarModule {
  static register(transport: CalendarTransport = createCalendarTransport()): DynamicModule {
    const options: Provider = {
      provide: GOOGLE_CALENDAR_OPTIONS,
      inject: [API_CONFIG],
      useFactory: (config: ApiConfig): CalendarHttpOptions => ({
        sessionSecret: config.sessionSecret,
        secureCookies: config.secureCookies,
        webPublicUrl: config.webPublicUrl ?? '',
      }),
    };
    const service: Provider = {
      provide: GOOGLE_CALENDAR_SERVICE,
      inject: [TENANT_DATABASE, AUDIT_SERVICE, API_CONFIG],
      useFactory: (database: TenantDatabase, audit: AuditService, config: ApiConfig) =>
        new GoogleCalendarService({
          database,
          audit,
          transport,
          cipher: tokenVaultFromEnv(config.mfaSeedKeys).slot('calendar_token'),
          config: calendarConfigFrom(process.env),
          apiPublicUrl: config.apiPublicUrl ?? config.webPublicUrl ?? '',
          webPublicUrl: config.webPublicUrl ?? '',
          // Slice B: Outlook uses the OneDrive app registration (`MICROSOFT_CLIENT_ID/SECRET`).
          microsoftConfigured: oneDriveConfigFrom(process.env) !== null,
        }),
    };
    // 53-14: push channels, the due-date mirror and the ICS feed.
    const urlsOf = (config: ApiConfig) => ({
      apiPublicUrl: config.apiPublicUrl ?? config.webPublicUrl ?? '',
      webPublicUrl: config.webPublicUrl ?? '',
    });
    const extras: Provider = {
      provide: CALENDAR_SYNC_EXTRAS,
      inject: [TENANT_DATABASE, API_CONFIG],
      useFactory: (database: TenantDatabase, config: ApiConfig) =>
        new CalendarSyncExtras(database, urlsOf(config)),
    };
    const feeds: Provider = {
      provide: CALENDAR_FEED_SERVICE,
      inject: [TENANT_DATABASE, AUDIT_SERVICE, API_CONFIG],
      useFactory: (database: TenantDatabase, audit: AuditService, config: ApiConfig) =>
        new CalendarFeedService(database, audit, urlsOf(config)),
    };
    const receiver: Provider = {
      provide: CALENDAR_PUSH_RECEIVER,
      inject: [TENANT_DATABASE, CALENDAR_SYNC_JOB],
      useFactory: (database: TenantDatabase, job: CalendarSyncJob) =>
        new CalendarPushReceiver(database, job),
    };
    // Slice B: the Outlook service (MicrosoftCalendarModule, global) joins the same port and job.
    // Optional, so a suite that registers only this module still boots.
    const microsoft = { token: MICROSOFT_CALENDAR_SERVICE, optional: true };
    const port: Provider = {
      provide: CALENDAR_SYNC,
      inject: [GOOGLE_CALENDAR_SERVICE, microsoft],
      useFactory: (google: GoogleCalendarService, outlook?: MicrosoftCalendarService) =>
        combineCalendarSync([google, outlook]),
    };
    const job: Provider = {
      provide: CALENDAR_SYNC_JOB,
      inject: [TENANT_DATABASE, GOOGLE_CALENDAR_SERVICE, CALENDAR_SYNC_EXTRAS, microsoft],
      useFactory: (
        database: TenantDatabase,
        google: GoogleCalendarService,
        syncExtras: CalendarSyncExtras,
        outlook?: MicrosoftCalendarService,
      ) =>
        new CalendarSyncJob(
          database,
          outlook ? [google, outlook] : [google],
          calendarSyncJobEnabled(),
          DEFAULT_CALENDAR_SYNC_JOB_OPTIONS,
          new GoogleCalendarRepository(),
          syncExtras,
        ),
    };
    return {
      module: GoogleCalendarModule,
      global: true,
      providers: [options, service, port, extras, job, feeds, receiver],
      exports: [port, job],
      controllers: [
        GoogleCalendarConnectionController,
        GoogleCalendarCallbackController,
        CalendarSyncSettingsController,
        CalendarPushController,
        CalendarFeedController,
      ],
    };
  }
}

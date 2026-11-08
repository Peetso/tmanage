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
import { createSeedCipher } from '../identity/seed-cipher.js';
import { expireCookie, readCookie, serializeCookie } from '../identity/session-token.js';
import { calendarConfigFrom } from '../google-calendar/google-calendar.google.js';
import {
  MSCAL_COOKIE_PATH,
  MSCAL_FLOW_COOKIE,
  MSCAL_FLOW_TTL_SECONDS,
  createMicrosoftCalendarTransport,
  microsoftCalendarConfigFrom,
  openMicrosoftCalendarFlow,
  sealMicrosoftCalendarFlow,
  type MicrosoftCalendarTransport,
} from './microsoft-calendar.graph.js';
import {
  MicrosoftCalendarService,
  type MicrosoftCalendarStatusView,
} from './microsoft-calendar.service.js';

/**
 * Outlook calendar + Teams meetings (0237, slice B) — the HTTP surface. Every route acts on the
 * CALLER'S OWN connection: there is no route that names another person.
 *
 * - `GET    …/integrations/microsoft-calendar` — the caller's Connected apps card.
 * - `POST   …/integrations/microsoft-calendar/connect` — `{url}` for Microsoft's consent screen;
 *   sets the signed flow cookie (state + PKCE verifier) bound to this person and organization.
 * - `GET    /v1/integrations/microsoft-calendar/callback` — Microsoft's redirect; forwards `code`
 *   and `state` in the URL fragment to Connected apps, which completes under the person's session.
 * - `POST   …/integrations/microsoft-calendar/complete` — `{code, state}`: exchange, encrypt, save.
 * - `DELETE …/integrations/microsoft-calendar` — disconnect (wipe the token).
 *
 * `meeting.read` to see the card, `meeting.write` to connect — the people who can schedule meetings.
 */

/** Exported globally: the Google module's calendar port and sync job pick it up (optional). */
export const MICROSOFT_CALENDAR_SERVICE = Symbol.for('tmanage.MicrosoftCalendarService');
const MICROSOFT_CALENDAR_OPTIONS = Symbol.for('tmanage.MicrosoftCalendarOptions');

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

@Controller('v1/organizations/:orgSlug/integrations/microsoft-calendar')
export class MicrosoftCalendarConnectionController {
  constructor(
    @Inject(MICROSOFT_CALENDAR_SERVICE) private readonly calendar: MicrosoftCalendarService,
    @Inject(MICROSOFT_CALENDAR_OPTIONS) private readonly options: CalendarHttpOptions,
  ) {}

  @Get()
  @RequireCapability('meeting.read')
  async status(@Ctx() context: TenantContext): Promise<MicrosoftCalendarStatusView> {
    return this.calendar.status(context);
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
      serializeCookie(
        MSCAL_FLOW_COOKIE,
        sealMicrosoftCalendarFlow(flow, this.options.sessionSecret),
        {
          path: MSCAL_COOKIE_PATH,
          maxAgeSeconds: MSCAL_FLOW_TTL_SECONDS,
          // `Lax`: the cookie must survive the top-level return from Microsoft.
          sameSite: 'Lax',
          secure: this.options.secureCookies,
        },
      ),
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
  ): Promise<MicrosoftCalendarStatusView> {
    const flow = openMicrosoftCalendarFlow(
      readCookie(cookieHeader(request), MSCAL_FLOW_COOKIE),
      this.options.sessionSecret,
    );
    // The flow is single-use whatever happens next.
    reply.header(
      'set-cookie',
      expireCookie(MSCAL_FLOW_COOKIE, {
        path: MSCAL_COOKIE_PATH,
        sameSite: 'Lax',
        secure: this.options.secureCookies,
      }),
    );
    return this.calendar.completeConnect(context, flow, { code: body?.code, state: body?.state });
  }

  @Delete()
  @RequireCapability('meeting.read')
  async disconnect(@Ctx() context: TenantContext): Promise<MicrosoftCalendarStatusView> {
    return this.calendar.disconnect(context);
  }
}

/**
 * Microsoft's redirect after consent. Public and tenant-less because Microsoft makes this request;
 * it only forwards. The organization comes from the signed flow cookie, and the code travels on in
 * the fragment (never sent to a server or a Referer).
 */
@Controller('v1/integrations/microsoft-calendar')
export class MicrosoftCalendarCallbackController {
  constructor(@Inject(MICROSOFT_CALENDAR_OPTIONS) private readonly options: CalendarHttpOptions) {}

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
      url: microsoftCalendarCallbackTarget(this.options, cookieHeader(request), code, state, error),
      statusCode: 302,
    };
  }
}

/** Where the callback sends the browser. Pure, so the forwarding rule is provable. */
export function microsoftCalendarCallbackTarget(
  options: Pick<CalendarHttpOptions, 'sessionSecret' | 'webPublicUrl'>,
  cookies: string | undefined,
  code: unknown,
  state: unknown,
  error?: unknown,
): string {
  const base = options.webPublicUrl.replace(/\/+$/, '');
  const flow = openMicrosoftCalendarFlow(
    readCookie(cookies, MSCAL_FLOW_COOKIE),
    options.sessionSecret,
  );
  if (!flow || !SLUG_PATTERN.test(flow.organizationSlug)) return `${base}/`;
  const screen = `${base}/${flow.organizationSlug}/settings/connected-apps`;
  if (typeof code !== 'string' || typeof state !== 'string' || code.length > 4096) {
    // R37: a provider error we explain travels on as `reason`, so the card can say why.
    const reason = providerErrorReason(error);
    return reason ? `${screen}#mscal=error&reason=${reason}` : `${screen}#mscal=error`;
  }
  return `${screen}#${new URLSearchParams({ mscal: 'complete', code, state }).toString()}`;
}

/**
 * Always registered and global. It exports {@link MICROSOFT_CALENDAR_SERVICE}, which the Google
 * module folds into the one calendar port the meetings services call and registers as the sync
 * job's Microsoft adapter. Without a Microsoft client in the environment the routes answer "not
 * configured" and every push/pull is a no-op.
 */
@Module({})
export class MicrosoftCalendarModule {
  static register(
    transport: MicrosoftCalendarTransport = createMicrosoftCalendarTransport(),
  ): DynamicModule {
    const options: Provider = {
      provide: MICROSOFT_CALENDAR_OPTIONS,
      inject: [API_CONFIG],
      useFactory: (config: ApiConfig): CalendarHttpOptions => ({
        sessionSecret: config.sessionSecret,
        secureCookies: config.secureCookies,
        webPublicUrl: config.webPublicUrl ?? '',
      }),
    };
    const service: Provider = {
      provide: MICROSOFT_CALENDAR_SERVICE,
      inject: [TENANT_DATABASE, AUDIT_SERVICE, API_CONFIG],
      useFactory: (database: TenantDatabase, audit: AuditService, config: ApiConfig) =>
        new MicrosoftCalendarService({
          database,
          audit,
          transport,
          cipher: createSeedCipher(config.mfaSeedKeys),
          config: microsoftCalendarConfigFrom(process.env),
          apiPublicUrl: config.apiPublicUrl ?? config.webPublicUrl ?? '',
          googleConfigured: calendarConfigFrom(process.env) !== null,
        }),
    };
    return {
      module: MicrosoftCalendarModule,
      global: true,
      providers: [options, service],
      exports: [service],
      controllers: [MicrosoftCalendarConnectionController, MicrosoftCalendarCallbackController],
    };
  }
}

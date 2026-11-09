import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Redirect,
  Req,
  Res,
} from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import {
  Ctx,
  CurrentPrincipal,
  NoTenant,
  Public,
  RequireCapability,
} from '../../common/http/decorators.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { expireCookie, readCookie, serializeCookie } from '../identity/session-token.js';
import type { ChannelLinkView } from '../automations/channel-links.service.js';
import {
  APP_CONNECT_COOKIE_PATH,
  APP_CONNECT_FLOW_TTL_SECONDS,
  appConnectCallbackTarget,
  appConnectCookieName,
  isAppConnectProvider,
  isWorkspaceSlug,
  openAppConnectFlow,
  sealAppConnectFlow,
  type AppConnectProvider,
} from './app-connect.flow.js';
import { APP_CONNECT_SERVICE } from './app-connect.service.js';
import type { AppConnectService, AppConnectView } from './app-connect.service.js';

export const APP_CONNECT_HTTP_OPTIONS = Symbol.for('tmanage.AppConnectHttpOptions');

export interface AppConnectHttpOptions {
  readonly sessionSecret: string;
  readonly secureCookies: boolean;
  readonly webPublicUrl: string;
}

interface CookieRequest {
  readonly headers: Record<string, string | string[] | undefined>;
}

interface CookieReply {
  header(name: string, value: string | readonly string[]): unknown;
}

function cookieHeader(request: CookieRequest): string | undefined {
  const raw = request.headers['cookie'];
  return Array.isArray(raw) ? raw.join('; ') : raw;
}

function providerOf(value: string): AppConnectProvider {
  if (!isAppConnectProvider(value)) {
    throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'app_connect_unknown');
  }
  return value;
}

/**
 * FIX5 — one-click Connect for GitHub, Slack and Microsoft Teams, owner/admin only
 * (`org.manage`). Every route is on the AI connector's NEVER list (they move OAuth tokens).
 */
@Controller('v1/organizations/:orgSlug/app-connect')
export class AppConnectController {
  constructor(
    @Inject(APP_CONNECT_SERVICE) private readonly service: AppConnectService,
    @Inject(APP_CONNECT_HTTP_OPTIONS) private readonly options: AppConnectHttpOptions,
  ) {}

  @Get(':provider')
  @RequireCapability('org.manage')
  status(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('provider') provider: string,
  ): Promise<AppConnectView> {
    return this.service.status(context, principal, providerOf(provider));
  }

  /** The provider's consent address; the signed flow cookie rides along for the return. */
  @Post(':provider/start')
  @RequireCapability('org.manage')
  @HttpCode(200)
  start(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('orgSlug') orgSlug: string,
    @Param('provider') provider: string,
    @Res({ passthrough: true }) reply: CookieReply,
  ): { readonly url: string } {
    if (!isWorkspaceSlug(orgSlug)) {
      throw new ApiError(400, 'validation_failed', 'The request is invalid', [
        { field: 'orgSlug', message: 'is not a workspace address' },
      ]);
    }
    const name = providerOf(provider);
    const { url, flow } = this.service.start(context, principal, name, orgSlug);
    reply.header(
      'set-cookie',
      serializeCookie(
        appConnectCookieName(name),
        sealAppConnectFlow(flow, this.options.sessionSecret),
        {
          path: APP_CONNECT_COOKIE_PATH,
          maxAgeSeconds: APP_CONNECT_FLOW_TTL_SECONDS,
          // `Lax`: the cookie must survive the top-level return from the provider.
          sameSite: 'Lax',
          secure: this.options.secureCookies,
        },
      ),
    );
    return { url };
  }

  /** Finish Connect with the `code` and `state` the provider sent back. */
  @Post(':provider/complete')
  @RequireCapability('org.manage')
  @HttpCode(200)
  complete(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('provider') provider: string,
    @Body() body: { readonly code?: unknown; readonly state?: unknown } | undefined,
    @Req() request: CookieRequest,
    @Res({ passthrough: true }) reply: CookieReply,
  ): Promise<AppConnectView> {
    const name = providerOf(provider);
    const flow = openAppConnectFlow(
      name,
      readCookie(cookieHeader(request), appConnectCookieName(name)),
      this.options.sessionSecret,
    );
    // The flow is single-use whatever happens next.
    reply.header(
      'set-cookie',
      expireCookie(appConnectCookieName(name), {
        path: APP_CONNECT_COOKIE_PATH,
        sameSite: 'Lax',
        secure: this.options.secureCookies,
      }),
    );
    return this.service.complete(context, principal, name, flow, {
      code: body?.code,
      state: body?.state,
    });
  }

  @Delete(':provider')
  @RequireCapability('org.manage')
  @HttpCode(200)
  disconnect(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('provider') provider: string,
  ): Promise<AppConnectView> {
    return this.service.disconnect(context, principal, providerOf(provider));
  }

  /** Slack: its public channels. Teams: your teams, or `?teamId=` one team's channels. */
  @Get(':provider/channels')
  @RequireCapability('org.manage')
  channels(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('provider') provider: string,
    @Query('teamId') teamId: unknown,
  ): ReturnType<AppConnectService['listChannels']> {
    return this.service.listChannels(context, principal, providerOf(provider), teamId);
  }

  /** Post notices to the picked channel. */
  @Post(':provider/channels')
  @RequireCapability('org.manage')
  @HttpCode(201)
  addChannel(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('provider') provider: string,
    @Body()
    body:
      | {
          readonly channelId?: unknown;
          readonly teamId?: unknown;
          readonly events?: unknown;
          readonly locale?: unknown;
        }
      | undefined,
  ): Promise<ChannelLinkView> {
    return this.service.addChannel(context, principal, providerOf(provider), body ?? {});
  }
}

/**
 * The providers' redirects after consent. Public and tenant-less because the provider's page makes
 * the request; they only forward `code` and `state` in the fragment to the Integrations page,
 * which completes under the owner's own session. The paths are the registered callbacks.
 */
@Controller('v1/integrations')
export class AppConnectCallbackController {
  constructor(@Inject(APP_CONNECT_HTTP_OPTIONS) private readonly options: AppConnectHttpOptions) {}

  private target(provider: AppConnectProvider, request: CookieRequest, query: Query3) {
    return {
      url: appConnectCallbackTarget(
        provider,
        this.options,
        readCookie(cookieHeader(request), appConnectCookieName(provider)),
        query,
      ),
      statusCode: 302,
    };
  }

  @Get('github/callback')
  @Public()
  @NoTenant()
  @Redirect()
  github(@Query() query: Query3, @Req() request: CookieRequest) {
    return this.target('github', request, query);
  }

  @Get('slack/callback')
  @Public()
  @NoTenant()
  @Redirect()
  slack(@Query() query: Query3, @Req() request: CookieRequest) {
    return this.target('slack', request, query);
  }

  @Get('teams/callback')
  @Public()
  @NoTenant()
  @Redirect()
  teams(@Query() query: Query3, @Req() request: CookieRequest) {
    return this.target('teams', request, query);
  }
}

interface Query3 {
  readonly code?: unknown;
  readonly state?: unknown;
  readonly error?: unknown;
}

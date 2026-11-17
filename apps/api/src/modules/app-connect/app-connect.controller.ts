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
import {
  expiredFlowCookie,
  flowCookie,
  isWorkspaceSlug,
  readFlowCookie,
  type CookieReply,
  type CookieRequest,
} from '../../common/http/oauth-flow.js';
import {
  appConnectCallbackTarget,
  appConnectCookieName,
  isAppConnectProvider,
  openAppConnectFlow,
  sealAppConnectFlow,
  type AppConnectProvider,
} from './app-connect.flow.js';
import { APP_CONNECT_SERVICE } from './app-connect.service.js';
import type { AppConnectService, AppConnectView } from './app-connect.service.js';
import { RequireIntegrationOn } from '../platform-admin/settings/integration-switch.js';

export const APP_CONNECT_HTTP_OPTIONS = Symbol.for('tmanage.AppConnectHttpOptions');

export interface AppConnectHttpOptions {
  readonly sessionSecret: string;
  readonly secureCookies: boolean;
  readonly webPublicUrl: string;
}

function providerOf(value: string): AppConnectProvider {
  if (!isAppConnectProvider(value)) {
    throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'app_connect_unknown');
  }
  return value;
}

/**
 * FIX5 — one-click Connect for GitHub, owner/admin only (`org.manage`). Every route is on the AI
 * connector's NEVER list (they move OAuth tokens). Slack and Microsoft Teams were removed
 * (2026-11-10): `:provider` slack or teams answers 404, and their channel routes are gone.
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
  @RequireIntegrationOn({ param: 'provider' })
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
      flowCookie(
        appConnectCookieName(name),
        sealAppConnectFlow(flow, this.options.sessionSecret),
        this.options.secureCookies,
      ),
    );
    return { url };
  }

  /** Finish Connect with the `code` and `state` the provider sent back. */
  @Post(':provider/complete')
  @RequireIntegrationOn({ param: 'provider' })
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
      readFlowCookie(request, appConnectCookieName(name)),
      this.options.sessionSecret,
    );
    // The flow is single-use whatever happens next.
    reply.header(
      'set-cookie',
      expiredFlowCookie(appConnectCookieName(name), this.options.secureCookies),
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
}

/**
 * GitHub's redirect after consent. Public and tenant-less because GitHub's page makes the request;
 * it only forwards `code` and `state` in the fragment to the Integrations page, which completes
 * under the owner's own session. The path is the registered callback. (The Slack and Teams
 * callbacks were removed and answer 404.)
 */
@Controller('v1/integrations')
export class AppConnectCallbackController {
  constructor(@Inject(APP_CONNECT_HTTP_OPTIONS) private readonly options: AppConnectHttpOptions) {}

  private target(provider: AppConnectProvider, request: CookieRequest, query: Query3) {
    return {
      url: appConnectCallbackTarget(
        provider,
        this.options,
        readFlowCookie(request, appConnectCookieName(provider)),
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
}

interface Query3 {
  readonly code?: unknown;
  readonly state?: unknown;
  readonly error?: unknown;
}

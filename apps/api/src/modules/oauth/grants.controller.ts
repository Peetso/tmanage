import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  createParamDecorator,
} from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { Ctx, RequireCapability } from '../../common/http/decorators.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { requestState } from '../../common/http/request-state.js';
import { AI_OWNER_CAPABILITY, isAiOwner } from './grants.service.js';
import type { ConnectedAppsService, ConnectedAppsView } from './grants.service.js';

export const CONNECTED_APPS_SERVICE = Symbol.for('tmanage.ConnectedAppsService');

interface Caller {
  readonly authScheme: string | undefined;
  readonly role: string | undefined;
}

const CurrentCaller = createParamDecorator((_data: unknown, context: ExecutionContext): Caller => {
  const state = requestState(context.switchToHttp().getRequest<object>());
  return { authScheme: state?.authScheme, role: state?.membership?.role };
});

/**
 * Only a person in a browser session may list, disconnect or switch AI apps. An AI app — by
 * personal access token, OAuth token or internal grant — must never change its own connection
 * (architecture B3).
 */
export function requireBrowserSession(authScheme: string | undefined): void {
  if (authScheme !== 'cookie') {
    throw new ApiError(
      403,
      'forbidden',
      MESSAGES.forbidden,
      undefined,
      'session_required_for_connected_apps',
    );
  }
}

/**
 * **Connected apps — `/v1/organizations/:orgSlug/oauth/*` (MCP connector S11).** The page at
 * `/<org>/settings/connected-apps`. `work.read` lets any internal member manage the apps they
 * connected; `org.security.manage` (the owner) sees all and flips the workspace switch. Every
 * route is on the AI registry's NEVER list.
 */
@Controller('v1/organizations/:orgSlug/oauth')
export class ConnectedAppsController {
  constructor(@Inject(CONNECTED_APPS_SERVICE) private readonly apps: ConnectedAppsService) {}

  @Get('grants')
  @RequireCapability('work.read')
  list(@Ctx() context: TenantContext, @CurrentCaller() caller: Caller): Promise<ConnectedAppsView> {
    requireBrowserSession(caller.authScheme);
    return this.apps.list(context, isAiOwner(caller.role));
  }

  @Post('grants/:grantId/revoke')
  @RequireCapability('work.read')
  @HttpCode(204)
  async revoke(
    @Ctx() context: TenantContext,
    @CurrentCaller() caller: Caller,
    @Param('grantId') grantId: string,
  ): Promise<void> {
    requireBrowserSession(caller.authScheme);
    await this.apps.revoke(context, isAiOwner(caller.role), grantId);
  }

  @Put('ai-access')
  @RequireCapability(AI_OWNER_CAPABILITY)
  setAiAccess(
    @Ctx() context: TenantContext,
    @CurrentCaller() caller: Caller,
    @Body() body: { enabled?: unknown } | undefined,
  ): Promise<{ aiAccessEnabled: boolean }> {
    requireBrowserSession(caller.authScheme);
    return this.apps.setAiAccess(context, body?.enabled);
  }
}

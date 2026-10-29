import { Body, Controller, Get, Inject, Param, Put, Req, UseGuards } from '@nestjs/common';
import { NoTenant } from '../../../common/http/decorators.js';
import { platformRequestContext } from '../platform-admin.access.js';
import { CurrentPlatformAdmin, PlatformAdminGuard } from '../platform-admin.guard.js';
import type { PlatformAdminActor } from '../platform-admin.guard.js';
import { RequirePlatformPermission } from '../require-platform-permission.decorator.js';
import type { PlatformSettingsService } from './settings.service.js';

export const PLATFORM_SETTINGS_SERVICE = Symbol.for('tmanage.PlatformSettingsService');

type Body = Readonly<Record<string, unknown>>;

/**
 * `/v1/platform/settings…` — Platform admin · Settings · General (D1, SPEC §5.6). Reads need
 * `platform.orgs.view`; every switch needs `platform.settings.edit`.
 */
@Controller('v1/platform')
@NoTenant()
@UseGuards(PlatformAdminGuard)
export class PlatformSettingsController {
  constructor(
    @Inject(PLATFORM_SETTINGS_SERVICE) private readonly service: PlatformSettingsService,
  ) {}

  @Get('settings')
  @RequirePlatformPermission('platform.settings.edit')
  settings(@Req() request: object) {
    return this.service.settings(platformRequestContext(request));
  }

  @Put('settings/public-signup')
  @RequirePlatformPermission('platform.settings.edit')
  setPublicSignup(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Body() body: { open?: unknown; reason?: unknown },
    @Req() request: object,
  ) {
    return this.service.setPublicSignup(actor, body ?? {}, platformRequestContext(request));
  }

  /** S11: the platform AI kill switch — `/mcp` and the OAuth endpoints answer 503 while off. */
  @Put('settings/ai-access')
  @RequirePlatformPermission('platform.settings.edit')
  setAiAccess(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Body() body: { on?: unknown; reason?: unknown },
    @Req() request: object,
  ) {
    return this.service.setAiAccess(actor, body ?? {}, platformRequestContext(request));
  }

  // ---- platform-admin v2 · PA-10 ----

  @Put('settings/billing-mode')
  @RequirePlatformPermission('platform.settings.edit')
  setBillingMode(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Body() body: Body,
    @Req() request: object,
  ) {
    return this.service.setBillingMode(actor, body ?? {}, platformRequestContext(request));
  }

  @Put('settings/beta-banner')
  @RequirePlatformPermission('platform.settings.edit')
  setBetaBanner(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Body() body: Body,
    @Req() request: object,
  ) {
    return this.service.setBetaBanner(actor, body ?? {}, platformRequestContext(request));
  }

  @Put('settings/retention')
  @RequirePlatformPermission('platform.settings.edit')
  setRetention(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Body() body: Body,
    @Req() request: object,
  ) {
    return this.service.setRetention(actor, body ?? {}, platformRequestContext(request));
  }

  @Put('settings/support-defaults')
  @RequirePlatformPermission('platform.settings.edit')
  setSupportDefaults(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Body() body: Body,
    @Req() request: object,
  ) {
    return this.service.setSupportDefaults(actor, body ?? {}, platformRequestContext(request));
  }

  @Get('settings/integrations')
  @RequirePlatformPermission('platform.orgs.view')
  integrations(@Req() request: object) {
    return this.service.integrations(platformRequestContext(request));
  }

  @Put('settings/integrations/:integration')
  @RequirePlatformPermission('platform.settings.edit')
  setIntegration(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('integration') integration: string,
    @Body() body: Body,
    @Req() request: object,
  ) {
    return this.service.setIntegration(
      actor,
      integration,
      body ?? {},
      platformRequestContext(request),
    );
  }
}

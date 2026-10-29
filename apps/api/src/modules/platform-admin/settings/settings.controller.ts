import { Body, Controller, Get, Inject, Put, Req, UseGuards } from '@nestjs/common';
import { NoTenant } from '../../../common/http/decorators.js';
import { platformRequestContext } from '../platform-admin.access.js';
import { CurrentPlatformAdmin, PlatformAdminGuard } from '../platform-admin.guard.js';
import type { PlatformAdminActor } from '../platform-admin.guard.js';
import { RequirePlatformPermission } from '../require-platform-permission.decorator.js';
import type { PlatformSettingsService } from './settings.service.js';

export const PLATFORM_SETTINGS_SERVICE = Symbol.for('tmanage.PlatformSettingsService');

/** `/v1/platform/settings…` — Platform admin · Settings. Moved here unchanged by the PA-02 split. */
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
}

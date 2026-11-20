import { Body, Controller, Get, HttpCode, Inject, Post, Put, Req, UseGuards } from '@nestjs/common';
import { NoTenant } from '../../../common/http/decorators.js';
import { platformRequestContext } from '../platform-admin.access.js';
import { CurrentPlatformAdmin, PlatformAdminGuard } from '../platform-admin.guard.js';
import type { PlatformAdminActor } from '../platform-admin.guard.js';
import { RequirePlatformPermission } from '../require-platform-permission.decorator.js';
import type { AiBudgetSettingsService } from './ai-budget.service.js';

export const PLATFORM_AI_BUDGET_SERVICE = Symbol.for('tmanage.PlatformAiBudgetService');

type JsonBody = Readonly<Record<string, unknown>> | null;

/**
 * `/v1/platform/settings/ai-budget` — 62-08: the AI pool caps under the env ceiling, the Sonnet
 * switch, pause/resume and the reserve release (step-up checked in the service). All need
 * `platform.settings.edit`, like the rest of Platform settings; every write is audited.
 */
@Controller('v1/platform/settings/ai-budget')
@NoTenant()
@UseGuards(PlatformAdminGuard)
export class PlatformAiBudgetController {
  constructor(
    @Inject(PLATFORM_AI_BUDGET_SERVICE) private readonly service: AiBudgetSettingsService,
  ) {}

  @Get()
  @RequirePlatformPermission('platform.settings.edit')
  read(@Req() request: object) {
    return this.service.read(platformRequestContext(request));
  }

  @Put()
  @RequirePlatformPermission('platform.settings.edit')
  update(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Body() body: JsonBody,
    @Req() request: object,
  ) {
    return this.service.update(actor, body ?? null, platformRequestContext(request));
  }

  @Post('pause')
  @HttpCode(200)
  @RequirePlatformPermission('platform.settings.edit')
  pause(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Body() body: JsonBody,
    @Req() request: object,
  ) {
    return this.service.pause(actor, body ?? null, platformRequestContext(request));
  }

  @Post('resume')
  @HttpCode(200)
  @RequirePlatformPermission('platform.settings.edit')
  resume(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Body() body: JsonBody,
    @Req() request: object,
  ) {
    return this.service.resume(actor, body ?? null, platformRequestContext(request));
  }

  @Post('reserve-release')
  @HttpCode(200)
  @RequirePlatformPermission('platform.settings.edit')
  releaseReserve(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Body() body: JsonBody,
    @Req() request: object,
  ) {
    return this.service.releaseReserve(actor, body ?? null, platformRequestContext(request));
  }
}

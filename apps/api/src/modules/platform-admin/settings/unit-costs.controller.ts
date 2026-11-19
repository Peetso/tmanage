import { Body, Controller, Get, Inject, Put, Req, UseGuards } from '@nestjs/common';
import { NoTenant } from '../../../common/http/decorators.js';
import { platformRequestContext } from '../platform-admin.access.js';
import { CurrentPlatformAdmin, PlatformAdminGuard } from '../platform-admin.guard.js';
import type { PlatformAdminActor } from '../platform-admin.guard.js';
import { RequirePlatformPermission } from '../require-platform-permission.decorator.js';
import type { UnitCostsService } from './unit-costs.service.js';

export const PLATFORM_UNIT_COSTS_SERVICE = Symbol.for('tmanage.PlatformUnitCostsService');

/**
 * `/v1/platform/settings/unit-costs` — 62-A3 (B14): the monthly hosting and mail costs the Growth
 * page divides by the active companies. Both need `platform.settings.edit`, like the settings page.
 */
@Controller('v1/platform/settings/unit-costs')
@NoTenant()
@UseGuards(PlatformAdminGuard)
export class PlatformUnitCostsController {
  constructor(@Inject(PLATFORM_UNIT_COSTS_SERVICE) private readonly service: UnitCostsService) {}

  @Get()
  @RequirePlatformPermission('platform.settings.edit')
  read(@Req() request: object) {
    return this.service.read(platformRequestContext(request));
  }

  @Put()
  @RequirePlatformPermission('platform.settings.edit')
  set(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Body() body: Readonly<Record<string, unknown>> | null,
    @Req() request: object,
  ) {
    return this.service.set(actor, body ?? null, platformRequestContext(request));
  }
}

import { Controller, Get, Inject, Query, Req, UseGuards } from '@nestjs/common';
import { NoTenant } from '../../../common/http/decorators.js';
import { platformRequestContext } from '../platform-admin.access.js';
import { CurrentPlatformAdmin, PlatformAdminGuard } from '../platform-admin.guard.js';
import type { PlatformAdminActor } from '../platform-admin.guard.js';
import { RequirePlatformPermission } from '../require-platform-permission.decorator.js';
import { PLATFORM_ACTIVITY_SERVICE } from './activity.controller.js';
import type { PlatformActivityService } from './activity.service.js';
import type { PlatformAdminActionsPageView } from './activity.service.js';

/**
 * C4 (platform-admin v2 · PA-09): `GET activity/platform?adminId&action&organizationId&from&to&cursor`
 * — what the operators did, with their reasons. `GET audit` (PA-02) stays as the old alias.
 */
@Controller('v1/platform/activity/platform')
@NoTenant()
@UseGuards(PlatformAdminGuard)
export class PlatformAdminActionsController {
  constructor(
    @Inject(PLATFORM_ACTIVITY_SERVICE) private readonly service: PlatformActivityService,
  ) {}

  @Get()
  @RequirePlatformPermission('platform.activity.view')
  list(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Query() query: Record<string, unknown>,
    @Req() request: object,
  ): Promise<PlatformAdminActionsPageView> {
    return this.service.platformActions(actor, query ?? {}, platformRequestContext(request));
  }
}

import { Controller, Get, Inject, Param, Query, Req, UseGuards } from '@nestjs/common';
import { NoTenant } from '../../../common/http/decorators.js';
import { platformRequestContext } from '../platform-admin.access.js';
import { CurrentPlatformAdmin, PlatformAdminGuard } from '../platform-admin.guard.js';
import type { PlatformAdminActor } from '../platform-admin.guard.js';
import { RequirePlatformPermission } from '../require-platform-permission.decorator.js';
import { PLATFORM_ACTIVITY_SERVICE } from './activity.controller.js';
import type { PlatformActivityService } from './activity.service.js';
import type { PlatformActionDetailView, PlatformActionsPageView } from './activity.service.js';

/**
 * C1/C2 (platform-admin v2 · PA-09):
 * - `GET activity/actions?…&cursor` — the cross-organization action log (metadata path);
 * - `GET activity/actions/:organizationId/:eventId` — one event with its before → after
 *   (tenant path for that organization; `platform.activity.detail`; itself audited).
 */
@Controller('v1/platform/activity/actions')
@NoTenant()
@UseGuards(PlatformAdminGuard)
export class PlatformActionsController {
  constructor(
    @Inject(PLATFORM_ACTIVITY_SERVICE) private readonly service: PlatformActivityService,
  ) {}

  @Get()
  @RequirePlatformPermission('platform.activity.view')
  list(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Query() query: Record<string, unknown>,
    @Req() request: object,
  ): Promise<PlatformActionsPageView> {
    return this.service.actions(actor, query ?? {}, platformRequestContext(request));
  }

  @Get(':organizationId/:eventId')
  @RequirePlatformPermission('platform.activity.detail')
  detail(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('organizationId') organizationId: string,
    @Param('eventId') eventId: string,
    @Req() request: object,
  ): Promise<PlatformActionDetailView> {
    return this.service.actionDetail(
      actor,
      organizationId,
      eventId,
      platformRequestContext(request),
    );
  }
}

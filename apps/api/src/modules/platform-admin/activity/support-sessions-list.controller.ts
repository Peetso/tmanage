import { Controller, Get, Inject, Query, Req, UseGuards } from '@nestjs/common';
import { NoTenant } from '../../../common/http/decorators.js';
import { platformRequestContext } from '../platform-admin.access.js';
import { PlatformAdminGuard } from '../platform-admin.guard.js';
import { RequirePlatformPermission } from '../require-platform-permission.decorator.js';
import { PLATFORM_ACTIVITY_SERVICE } from './activity.controller.js';
import type {
  PlatformActivityService,
  PlatformActivitySupportSessionsView,
} from './activity.service.js';

/**
 * C5 (platform-admin v2 · PA-09): `GET activity/support-sessions?state&adminId&organizationId` —
 * every Support session ever, open ones first (PA-05's repository). "End now" is PA-05's
 * `DELETE support-sessions/:id`.
 */
@Controller('v1/platform/activity/support-sessions')
@NoTenant()
@UseGuards(PlatformAdminGuard)
export class PlatformSupportSessionsListController {
  constructor(
    @Inject(PLATFORM_ACTIVITY_SERVICE) private readonly service: PlatformActivityService,
  ) {}

  @Get()
  @RequirePlatformPermission('platform.activity.view')
  list(
    @Query() query: Record<string, unknown>,
    @Req() request: object,
  ): Promise<PlatformActivitySupportSessionsView> {
    return this.service.supportSessions(query ?? {}, platformRequestContext(request));
  }
}

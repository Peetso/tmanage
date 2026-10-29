import { Controller, Get, Inject, Req, UseGuards } from '@nestjs/common';
import { NoTenant } from '../../../common/http/decorators.js';
import { platformRequestContext } from '../platform-admin.access.js';
import { PlatformAdminGuard } from '../platform-admin.guard.js';
import { RequirePlatformPermission } from '../require-platform-permission.decorator.js';
import type { PlatformActivityService } from './activity.service.js';

export const PLATFORM_ACTIVITY_SERVICE = Symbol.for('tmanage.PlatformActivityService');

/**
 * `/v1/platform/audit` — the PA-02 alias of C4, kept so older clients keep working (platform-admin
 * v2 · PA-09: `activity/platform` is the new route; the C1–C6 routes live beside this file).
 */
@Controller('v1/platform')
@NoTenant()
@UseGuards(PlatformAdminGuard)
export class PlatformActivityController {
  constructor(
    @Inject(PLATFORM_ACTIVITY_SERVICE) private readonly service: PlatformActivityService,
  ) {}

  @Get('audit')
  @RequirePlatformPermission('platform.activity.view')
  audit(@Req() request: object) {
    return this.service.auditLog(platformRequestContext(request));
  }
}

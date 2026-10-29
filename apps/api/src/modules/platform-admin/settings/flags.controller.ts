import { Body, Controller, Get, Inject, Param, Put, Query, Req, UseGuards } from '@nestjs/common';
import { NoTenant } from '../../../common/http/decorators.js';
import { platformRequestContext } from '../platform-admin.access.js';
import { CurrentPlatformAdmin, PlatformAdminGuard } from '../platform-admin.guard.js';
import type { PlatformAdminActor } from '../platform-admin.guard.js';
import { RequirePlatformPermission } from '../require-platform-permission.decorator.js';
import type { PlatformFlagsService } from './flags.service.js';

export const PLATFORM_FLAGS_SERVICE = Symbol.for('tmanage.PlatformFlagsService');

/** `/v1/platform/flags…` — D2 Feature flags (SPEC §5.6). */
@Controller('v1/platform/flags')
@NoTenant()
@UseGuards(PlatformAdminGuard)
export class PlatformFlagsController {
  constructor(@Inject(PLATFORM_FLAGS_SERVICE) private readonly service: PlatformFlagsService) {}

  @Get()
  @RequirePlatformPermission('platform.orgs.view')
  list(@Req() request: object) {
    return this.service.list(platformRequestContext(request));
  }

  @Get(':flagKey/organizations')
  @RequirePlatformPermission('platform.orgs.view')
  organizations(
    @Param('flagKey') flagKey: string,
    @Query('q') query: unknown,
    @Req() request: object,
  ) {
    return this.service.organizations(flagKey, query, platformRequestContext(request));
  }

  @Put(':flagKey')
  @RequirePlatformPermission('platform.flags.edit')
  update(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('flagKey') flagKey: string,
    @Body() body: Readonly<Record<string, unknown>>,
    @Req() request: object,
  ) {
    return this.service.update(actor, flagKey, body ?? {}, platformRequestContext(request));
  }
}

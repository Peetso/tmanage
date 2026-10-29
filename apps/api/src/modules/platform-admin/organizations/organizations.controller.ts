import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { NoTenant } from '../../../common/http/decorators.js';
import { platformRequestContext } from '../platform-admin.access.js';
import { CurrentPlatformAdmin, PlatformAdminGuard } from '../platform-admin.guard.js';
import type { PlatformAdminActor } from '../platform-admin.guard.js';
import { RequirePlatformPermission } from '../require-platform-permission.decorator.js';
import type { PlatformOrganizationsService } from './organizations.service.js';

export const PLATFORM_ORGANIZATIONS_SERVICE = Symbol.for('tmanage.PlatformOrganizationsService');

interface ReasonInput {
  readonly reason?: unknown;
}

/**
 * `/v1/platform/{overview,companies…}` — Platform admin · Organizations. Moved here unchanged by
 * the PA-02 split, each route now naming its platform permission.
 */
@Controller('v1/platform')
@NoTenant()
@UseGuards(PlatformAdminGuard)
export class PlatformOrganizationsController {
  constructor(
    @Inject(PLATFORM_ORGANIZATIONS_SERVICE) private readonly service: PlatformOrganizationsService,
  ) {}

  @Get('overview')
  @RequirePlatformPermission('platform.orgs.view')
  overview(@Req() request: object) {
    return this.service.overview(platformRequestContext(request));
  }

  @Get('companies')
  @RequirePlatformPermission('platform.orgs.view')
  companies(@Query('q') search: unknown, @Req() request: object) {
    return this.service.companies(search, platformRequestContext(request));
  }

  @Get('companies/:organizationId')
  @RequirePlatformPermission('platform.orgs.view')
  company(@Param('organizationId') id: string, @Req() request: object) {
    return this.service.company(id, platformRequestContext(request));
  }

  @Post('companies/:organizationId/suspension')
  @RequirePlatformPermission('platform.orgs.lifecycle')
  @HttpCode(200)
  suspend(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('organizationId') id: string,
    @Body() body: ReasonInput,
    @Req() request: object,
  ) {
    return this.service.setSuspended(actor, id, true, body ?? {}, platformRequestContext(request));
  }

  @Post('companies/:organizationId/reactivation')
  @RequirePlatformPermission('platform.orgs.lifecycle')
  @HttpCode(200)
  reactivate(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('organizationId') id: string,
    @Body() body: ReasonInput,
    @Req() request: object,
  ) {
    return this.service.setSuspended(actor, id, false, body ?? {}, platformRequestContext(request));
  }
}

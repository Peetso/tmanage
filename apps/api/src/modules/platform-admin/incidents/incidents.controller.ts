import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { NoTenant } from '../../../common/http/decorators.js';
import { platformRequestContext } from '../platform-admin.access.js';
import { CurrentPlatformAdmin, PlatformAdminGuard } from '../platform-admin.guard.js';
import type { PlatformAdminActor } from '../platform-admin.guard.js';
import { RequirePlatformPermission } from '../require-platform-permission.decorator.js';
import type { PlatformIncidentsService } from './incidents.service.js';

export const PLATFORM_INCIDENTS_SERVICE = Symbol.for('tmanage.PlatformIncidentsService');

type Body = Readonly<Record<string, unknown>>;

/**
 * 56-13 — `/v1/platform/incidents…`: the incident register with its legal clocks. Every route needs
 * `platform.settings.edit` (super admin by default): a register row can name affected customers
 * and an unfixed hole. Publish/unpublish put the six public fields on the status page.
 */
@Controller('v1/platform/incidents')
@NoTenant()
@UseGuards(PlatformAdminGuard)
export class PlatformIncidentsController {
  constructor(
    @Inject(PLATFORM_INCIDENTS_SERVICE) private readonly service: PlatformIncidentsService,
  ) {}

  @Get()
  @RequirePlatformPermission('platform.settings.edit')
  list(@Req() request: object) {
    return this.service.list(platformRequestContext(request));
  }

  @Post()
  @HttpCode(201)
  @RequirePlatformPermission('platform.settings.edit')
  create(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Body() body: Body,
    @Req() request: object,
  ) {
    return this.service.create(actor, body ?? {}, platformRequestContext(request));
  }

  @Put(':id')
  @RequirePlatformPermission('platform.settings.edit')
  update(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('id') id: string,
    @Body() body: Body,
    @Req() request: object,
  ) {
    return this.service.update(actor, id, body ?? {}, platformRequestContext(request));
  }

  @Post(':id/publish')
  @HttpCode(200)
  @RequirePlatformPermission('platform.settings.edit')
  publish(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('id') id: string,
    @Body() body: Body,
    @Req() request: object,
  ) {
    return this.service.setPublished(actor, id, true, body ?? {}, platformRequestContext(request));
  }

  @Post(':id/unpublish')
  @HttpCode(200)
  @RequirePlatformPermission('platform.settings.edit')
  unpublish(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('id') id: string,
    @Body() body: Body,
    @Req() request: object,
  ) {
    return this.service.setPublished(actor, id, false, body ?? {}, platformRequestContext(request));
  }

  @Post(':id/resolve')
  @HttpCode(200)
  @RequirePlatformPermission('platform.settings.edit')
  resolve(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('id') id: string,
    @Body() body: Body,
    @Req() request: object,
  ) {
    return this.service.resolve(actor, id, body ?? {}, platformRequestContext(request));
  }
}

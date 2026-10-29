import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { NoTenant } from '../../../common/http/decorators.js';
import { platformRequestContext } from '../platform-admin.access.js';
import { CurrentPlatformAdmin, PlatformAdminGuard } from '../platform-admin.guard.js';
import type { PlatformAdminActor } from '../platform-admin.guard.js';
import { RequirePlatformPermission } from '../require-platform-permission.decorator.js';
import type { PlatformAnnouncementsService } from './announcements.service.js';

export const PLATFORM_ANNOUNCEMENTS_SERVICE = Symbol.for('tmanage.PlatformAnnouncementsService');

type Body = Readonly<Record<string, unknown>>;

/** `/v1/platform/announcements…` — D3 the platform banner (SPEC §5.6). */
@Controller('v1/platform/announcements')
@NoTenant()
@UseGuards(PlatformAdminGuard)
export class PlatformAnnouncementsController {
  constructor(
    @Inject(PLATFORM_ANNOUNCEMENTS_SERVICE)
    private readonly service: PlatformAnnouncementsService,
  ) {}

  @Get()
  @RequirePlatformPermission('platform.orgs.view')
  list(@Req() request: object) {
    return this.service.list(platformRequestContext(request));
  }

  @Post()
  @HttpCode(201)
  @RequirePlatformPermission('platform.announcements.edit')
  create(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Body() body: Body,
    @Req() request: object,
  ) {
    return this.service.create(actor, body ?? {}, platformRequestContext(request));
  }

  @Patch(':id')
  @RequirePlatformPermission('platform.announcements.edit')
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
  @RequirePlatformPermission('platform.announcements.edit')
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
  @RequirePlatformPermission('platform.announcements.edit')
  unpublish(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('id') id: string,
    @Body() body: Body,
    @Req() request: object,
  ) {
    return this.service.setPublished(actor, id, false, body ?? {}, platformRequestContext(request));
  }

  /** Soft: unpublish + archive. */
  @Delete(':id')
  @HttpCode(200)
  @RequirePlatformPermission('platform.announcements.edit')
  archive(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('id') id: string,
    @Body() body: Body,
    @Req() request: object,
  ) {
    return this.service.archive(actor, id, body ?? {}, platformRequestContext(request));
  }
}

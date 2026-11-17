import { Body, Controller, Get, Inject, Param, Post, Put, Req, UseGuards } from '@nestjs/common';
import { NoTenant } from '../../../common/http/decorators.js';
import { platformRequestContext } from '../platform-admin.access.js';
import { CurrentPlatformAdmin, PlatformAdminGuard } from '../platform-admin.guard.js';
import type { PlatformAdminActor } from '../platform-admin.guard.js';
import { RequirePlatformPermission } from '../require-platform-permission.decorator.js';
import type { MailPeopleService } from './mail-people.service.js';

export const PLATFORM_MAIL_PEOPLE_SERVICE = Symbol.for('tmanage.PlatformMailPeopleService');

type Body = Readonly<Record<string, unknown>>;

/** `/v1/platform/mail-people…` — EMAILBUILD, the "E-mail people" card on platform settings. */
@Controller('v1/platform/mail-people')
@NoTenant()
@UseGuards(PlatformAdminGuard)
export class PlatformMailPeopleController {
  constructor(@Inject(PLATFORM_MAIL_PEOPLE_SERVICE) private readonly service: MailPeopleService) {}

  @Get()
  @RequirePlatformPermission('platform.settings.edit')
  list(@Req() request: object) {
    return this.service.list(platformRequestContext(request));
  }

  @Post()
  @RequirePlatformPermission('platform.settings.edit')
  create(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Body() body: Body,
    @Req() request: object,
  ) {
    return this.service.create(actor, body ?? {}, platformRequestContext(request));
  }

  @Post('import')
  @RequirePlatformPermission('platform.settings.edit')
  importList(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Body() body: Body,
    @Req() request: object,
  ) {
    return this.service.importCsv(actor, body ?? {}, platformRequestContext(request));
  }

  @Put(':personId')
  @RequirePlatformPermission('platform.settings.edit')
  update(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('personId') personId: string,
    @Body() body: Body,
    @Req() request: object,
  ) {
    return this.service.update(actor, personId, body ?? {}, platformRequestContext(request));
  }

  @Post(':personId/test')
  @RequirePlatformPermission('platform.settings.edit')
  sendTest(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('personId') personId: string,
    @Body() body: Body,
    @Req() request: object,
  ) {
    return this.service.sendTest(actor, personId, body ?? {}, platformRequestContext(request));
  }
}

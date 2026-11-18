import { Body, Controller, Get, Inject, Param, Post, Put, Req, UseGuards } from '@nestjs/common';
import { NoTenant } from '../../../common/http/decorators.js';
import { platformRequestContext } from '../platform-admin.access.js';
import { CurrentPlatformAdmin, PlatformAdminGuard } from '../platform-admin.guard.js';
import type { PlatformAdminActor } from '../platform-admin.guard.js';
import { RequirePlatformPermission } from '../require-platform-permission.decorator.js';
import type { PersonMailService } from './person-mail.service.js';

export const PLATFORM_PERSON_MAIL_SERVICE = Symbol.for('tmanage.PlatformPersonMailService');

type Body = Readonly<Record<string, unknown>>;

/**
 * `/v1/platform/person-mail…` — EMAILBUILD2, the "Tips and reminders" switch and the "Feature
 * news" card on platform settings.
 */
@Controller('v1/platform/person-mail')
@NoTenant()
@UseGuards(PlatformAdminGuard)
export class PlatformPersonMailController {
  constructor(@Inject(PLATFORM_PERSON_MAIL_SERVICE) private readonly service: PersonMailService) {}

  @Get()
  @RequirePlatformPermission('platform.settings.edit')
  state(@Req() request: object) {
    return this.service.state(platformRequestContext(request));
  }

  @Put('switch')
  @RequirePlatformPermission('platform.settings.edit')
  setSwitch(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Body() body: Body,
    @Req() request: object,
  ) {
    return this.service.setSwitch(actor, body ?? {}, platformRequestContext(request));
  }

  @Post('news')
  @RequirePlatformPermission('platform.settings.edit')
  createNews(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Body() body: Body,
    @Req() request: object,
  ) {
    return this.service.createNews(actor, body ?? {}, platformRequestContext(request));
  }

  @Post('news/:newsId/send')
  @RequirePlatformPermission('platform.settings.edit')
  sendNews(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('newsId') newsId: string,
    @Req() request: object,
  ) {
    return this.service.sendNews(actor, newsId, platformRequestContext(request));
  }
}

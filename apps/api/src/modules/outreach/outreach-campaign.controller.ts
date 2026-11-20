import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { NoTenant } from '../../common/http/decorators.js';
import { platformRequestContext } from '../platform-admin/platform-admin.access.js';
import {
  CurrentPlatformAdmin,
  PlatformAdminGuard,
} from '../platform-admin/platform-admin.guard.js';
import type { PlatformAdminActor } from '../platform-admin/platform-admin.guard.js';
import { RequirePlatformPermission } from '../platform-admin/require-platform-permission.decorator.js';
import type {
  OutreachCampaignService,
  OutreachImportView,
  OutreachView,
} from './outreach-campaign.service.js';

export const PLATFORM_OUTREACH_SERVICE = Symbol.for('tmanage.PlatformOutreachService');

type Body = Readonly<Record<string, unknown>>;

/**
 * LANE-Q — `/v1/platform/outreach…`, Platform admin -> Outreach. Platform admins with
 * `platform.settings.edit` only; customers never reach it (no tenant, the platform guard).
 */
@Controller('v1/platform/outreach')
@NoTenant()
@UseGuards(PlatformAdminGuard)
export class PlatformOutreachController {
  constructor(
    @Inject(PLATFORM_OUTREACH_SERVICE) private readonly service: OutreachCampaignService,
  ) {}

  @Get()
  @RequirePlatformPermission('platform.settings.edit')
  view(@Req() request: object): Promise<OutreachView> {
    return this.service.view(platformRequestContext(request));
  }

  @Post('import')
  @HttpCode(201)
  @RequirePlatformPermission('platform.settings.edit')
  importList(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Body() body: Body,
    @Req() request: object,
  ): Promise<OutreachImportView> {
    return this.service.importCsv(actor, body ?? {}, platformRequestContext(request));
  }

  @Post('campaigns/:campaignId/start')
  @HttpCode(200)
  @RequirePlatformPermission('platform.settings.edit')
  start(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('campaignId') campaignId: string,
    @Req() request: object,
  ): Promise<OutreachView> {
    return this.service.move(actor, campaignId, 'start', platformRequestContext(request));
  }

  @Post('campaigns/:campaignId/pause')
  @HttpCode(200)
  @RequirePlatformPermission('platform.settings.edit')
  pause(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('campaignId') campaignId: string,
    @Req() request: object,
  ): Promise<OutreachView> {
    return this.service.move(actor, campaignId, 'pause', platformRequestContext(request));
  }

  @Post('campaigns/:campaignId/stop')
  @HttpCode(200)
  @RequirePlatformPermission('platform.settings.edit')
  stop(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('campaignId') campaignId: string,
    @Req() request: object,
  ): Promise<OutreachView> {
    return this.service.move(actor, campaignId, 'stop', platformRequestContext(request));
  }

  @Post('recipients/:recipientId/bounced')
  @HttpCode(200)
  @RequirePlatformPermission('platform.settings.edit')
  bounced(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('recipientId') recipientId: string,
    @Req() request: object,
  ): Promise<OutreachView> {
    return this.service.markBounced(actor, recipientId, platformRequestContext(request));
  }
}

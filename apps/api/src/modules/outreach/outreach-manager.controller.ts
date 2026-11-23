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
  Put,
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
  OutreachCampaignDetailView,
  OutreachExportView,
  OutreachManagerService,
  OutreachPreviewView,
  OutreachRecipientsImportView,
  OutreachRecipientsView,
  OutreachTestSendView,
  OutreachVersionTextView,
} from './outreach-manager.service.js';

export const PLATFORM_OUTREACH_MANAGER_SERVICE = Symbol.for(
  'tmanage.PlatformOutreachManagerService',
);

type Body = Readonly<Record<string, unknown>>;

/**
 * OUTREACH MANAGER — `/v1/platform/outreach/campaigns…` and `/recipients…`: one campaign's
 * settings, e-mail (versions, preview, test send) and recipients. Guarded exactly like the LANE-Q
 * routes: platform admins with `platform.settings.edit` only (no tenant, the platform guard);
 * every change is audited by the service in the same transaction.
 */
@Controller('v1/platform/outreach')
@NoTenant()
@UseGuards(PlatformAdminGuard)
export class PlatformOutreachManagerController {
  constructor(
    @Inject(PLATFORM_OUTREACH_MANAGER_SERVICE) private readonly service: OutreachManagerService,
  ) {}

  @Post('campaigns')
  @HttpCode(201)
  @RequirePlatformPermission('platform.settings.edit')
  create(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Body() body: Body,
    @Req() request: object,
  ): Promise<OutreachCampaignDetailView> {
    return this.service.create(actor, body ?? {}, platformRequestContext(request));
  }

  @Get('campaigns/:campaignId')
  @RequirePlatformPermission('platform.settings.edit')
  detail(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('campaignId') campaignId: string,
    @Req() request: object,
  ): Promise<OutreachCampaignDetailView> {
    return this.service.detail(actor, campaignId, platformRequestContext(request));
  }

  @Patch('campaigns/:campaignId')
  @HttpCode(200)
  @RequirePlatformPermission('platform.settings.edit')
  update(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('campaignId') campaignId: string,
    @Body() body: Body,
    @Req() request: object,
  ): Promise<OutreachCampaignDetailView> {
    return this.service.update(actor, campaignId, body ?? {}, platformRequestContext(request));
  }

  @Post('campaigns/:campaignId/duplicate')
  @HttpCode(201)
  @RequirePlatformPermission('platform.settings.edit')
  duplicate(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('campaignId') campaignId: string,
    @Body() body: Body,
    @Req() request: object,
  ): Promise<OutreachCampaignDetailView> {
    return this.service.duplicate(actor, campaignId, body ?? {}, platformRequestContext(request));
  }

  @Post('campaigns/:campaignId/archive')
  @HttpCode(200)
  @RequirePlatformPermission('platform.settings.edit')
  archive(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('campaignId') campaignId: string,
    @Req() request: object,
  ): Promise<OutreachCampaignDetailView> {
    return this.service.archive(actor, campaignId, true, platformRequestContext(request));
  }

  @Post('campaigns/:campaignId/unarchive')
  @HttpCode(200)
  @RequirePlatformPermission('platform.settings.edit')
  unarchive(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('campaignId') campaignId: string,
    @Req() request: object,
  ): Promise<OutreachCampaignDetailView> {
    return this.service.archive(actor, campaignId, false, platformRequestContext(request));
  }

  @Put('campaigns/:campaignId/emails/:kind')
  @HttpCode(200)
  @RequirePlatformPermission('platform.settings.edit')
  saveEmail(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('campaignId') campaignId: string,
    @Param('kind') kind: string,
    @Body() body: Body,
    @Req() request: object,
  ): Promise<OutreachCampaignDetailView> {
    return this.service.saveEmail(
      actor,
      campaignId,
      kind,
      body ?? {},
      platformRequestContext(request),
    );
  }

  @Get('campaigns/:campaignId/emails/:kind/versions/:version')
  @RequirePlatformPermission('platform.settings.edit')
  version(
    @Param('campaignId') campaignId: string,
    @Param('kind') kind: string,
    @Param('version') version: string,
    @Req() request: object,
  ): Promise<OutreachVersionTextView> {
    return this.service.versionText(campaignId, kind, version, platformRequestContext(request));
  }

  @Post('campaigns/:campaignId/preview')
  @HttpCode(200)
  @RequirePlatformPermission('platform.settings.edit')
  async preview(
    @Param('campaignId') campaignId: string,
    @Body() body: Body,
    @Req() request: object,
  ): Promise<OutreachPreviewView> {
    const view = await this.service.preview(
      campaignId,
      body ?? {},
      platformRequestContext(request),
    );
    return {
      from: view.from,
      to: view.to,
      subject: view.subject,
      text: view.text,
      recipientId: view.recipientId,
      problems: view.problems,
    };
  }

  @Post('campaigns/:campaignId/test-send')
  @HttpCode(200)
  @RequirePlatformPermission('platform.settings.edit')
  testSend(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('campaignId') campaignId: string,
    @Body() body: Body,
    @Req() request: object,
  ): Promise<OutreachTestSendView> {
    return this.service.testSend(actor, campaignId, body ?? {}, platformRequestContext(request));
  }

  @Get('campaigns/:campaignId/recipients')
  @RequirePlatformPermission('platform.settings.edit')
  recipients(
    @Param('campaignId') campaignId: string,
    @Req() request: object,
  ): Promise<OutreachRecipientsView> {
    return this.service.recipients(campaignId, platformRequestContext(request));
  }

  @Post('campaigns/:campaignId/recipients')
  @HttpCode(201)
  @RequirePlatformPermission('platform.settings.edit')
  addRecipient(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('campaignId') campaignId: string,
    @Body() body: Body,
    @Req() request: object,
  ): Promise<OutreachRecipientsView> {
    return this.service.addRecipient(
      actor,
      campaignId,
      body ?? {},
      platformRequestContext(request),
    );
  }

  @Post('campaigns/:campaignId/import')
  @HttpCode(201)
  @RequirePlatformPermission('platform.settings.edit')
  importInto(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('campaignId') campaignId: string,
    @Body() body: Body,
    @Req() request: object,
  ): Promise<OutreachRecipientsImportView> {
    return this.service.importInto(actor, campaignId, body ?? {}, platformRequestContext(request));
  }

  @Post('campaigns/:campaignId/export')
  @HttpCode(200)
  @RequirePlatformPermission('platform.settings.edit')
  exportCsv(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('campaignId') campaignId: string,
    @Req() request: object,
  ): Promise<OutreachExportView> {
    return this.service.exportCsv(actor, campaignId, platformRequestContext(request));
  }

  @Patch('recipients/:recipientId')
  @HttpCode(200)
  @RequirePlatformPermission('platform.settings.edit')
  updateRecipient(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('recipientId') recipientId: string,
    @Body() body: Body,
    @Req() request: object,
  ): Promise<OutreachRecipientsView> {
    return this.service.updateRecipient(
      actor,
      recipientId,
      body ?? {},
      platformRequestContext(request),
    );
  }

  @Delete('recipients/:recipientId')
  @HttpCode(200)
  @RequirePlatformPermission('platform.settings.edit')
  removeRecipient(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('recipientId') recipientId: string,
    @Req() request: object,
  ): Promise<OutreachRecipientsView> {
    return this.service.removeRecipient(actor, recipientId, platformRequestContext(request));
  }

  @Post('recipients/:recipientId/replied')
  @HttpCode(200)
  @RequirePlatformPermission('platform.settings.edit')
  replied(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('recipientId') recipientId: string,
    @Req() request: object,
  ): Promise<OutreachRecipientsView> {
    return this.service.markReplied(actor, recipientId, platformRequestContext(request));
  }
}

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
import { NoTenant } from '../../common/http/decorators.js';
import { platformRequestContext } from '../platform-admin/platform-admin.access.js';
import {
  CurrentPlatformAdmin,
  PlatformAdminGuard,
} from '../platform-admin/platform-admin.guard.js';
import type { PlatformAdminActor } from '../platform-admin/platform-admin.guard.js';
import { RequirePlatformPermission } from '../platform-admin/require-platform-permission.decorator.js';
import type {
  AiPackGrantView,
  AiPackRequestQueueView,
  AiPacksPlatformService,
  AiTestListEntryView,
  AiTestListView,
} from './ai-packs-platform.service.js';

/** Slice-private token, so `tokens.ts` stays untouched. */
export const AI_PACKS_PLATFORM_SERVICE = Symbol.for('tmanage.AiPacksPlatformService');

/**
 * `/v1/platform/ai/test-list` — 62-07 (plan 62 §5, J1). The AI test list and the credit packs.
 * Money-adjacent, so every route needs `platform.settings.edit` (super admin by default), like the
 * plan ladder; the guard's live step-up applies. No organization comes from a body: it is the path
 * id, checked to exist inside the transaction. Writes carry the admin's typed reason.
 */
@Controller('v1/platform/ai/test-list')
@NoTenant()
@UseGuards(PlatformAdminGuard)
export class PlatformAiTestListController {
  constructor(
    @Inject(AI_PACKS_PLATFORM_SERVICE) private readonly service: AiPacksPlatformService,
  ) {}

  @Get()
  @RequirePlatformPermission('platform.settings.edit')
  list(@Req() request: object): Promise<AiTestListView> {
    return this.service.testList(platformRequestContext(request));
  }

  @Put(':organizationId')
  @RequirePlatformPermission('platform.settings.edit')
  setEntry(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('organizationId') organizationId: string,
    @Body() body: unknown,
    @Req() request: object,
  ): Promise<AiTestListEntryView> {
    return this.service.setEntry(actor, organizationId, body, platformRequestContext(request));
  }

  @Post(':organizationId/packs')
  @RequirePlatformPermission('platform.settings.edit')
  @HttpCode(201)
  grantPack(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('organizationId') organizationId: string,
    @Body() body: unknown,
    @Req() request: object,
  ): Promise<AiPackGrantView> {
    return this.service.grantPack(actor, organizationId, body, platformRequestContext(request));
  }

  @Post(':organizationId/pack-requests/:requestId/decline')
  @RequirePlatformPermission('platform.settings.edit')
  @HttpCode(200)
  declineRequest(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('organizationId') organizationId: string,
    @Param('requestId') requestId: string,
    @Body() body: unknown,
    @Req() request: object,
  ): Promise<AiPackRequestQueueView> {
    return this.service.declineRequest(
      actor,
      organizationId,
      requestId,
      body,
      platformRequestContext(request),
    );
  }
}

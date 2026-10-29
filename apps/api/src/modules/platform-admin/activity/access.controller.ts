import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { NoTenant } from '../../../common/http/decorators.js';
import { platformRequestContext } from '../platform-admin.access.js';
import { CurrentPlatformAdmin, PlatformAdminGuard } from '../platform-admin.guard.js';
import type { PlatformAdminActor } from '../platform-admin.guard.js';
import { RequirePlatformPermission } from '../require-platform-permission.decorator.js';
import { PLATFORM_ACTIVITY_SERVICE } from './activity.controller.js';
import type { PlatformActivityService } from './activity.service.js';
import type {
  PlatformLiveSessionsPageView,
  PlatformSessionEndedView,
  PlatformSignInsPageView,
  PlatformStepUpsPageView,
  PlatformSuspiciousView,
} from './activity.service.js';

/**
 * C3 access log (platform-admin v2 · PA-09): sign-ins, live sessions (end one — reason
 * required, `platform.people.security`), step-ups and suspicious patterns.
 */
@Controller('v1/platform/activity/access')
@NoTenant()
@UseGuards(PlatformAdminGuard)
export class PlatformAccessController {
  constructor(
    @Inject(PLATFORM_ACTIVITY_SERVICE) private readonly service: PlatformActivityService,
  ) {}

  @Get('sign-ins')
  @RequirePlatformPermission('platform.activity.view')
  signIns(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Query() query: Record<string, unknown>,
    @Req() request: object,
  ): Promise<PlatformSignInsPageView> {
    return this.service.signIns(actor, query ?? {}, platformRequestContext(request));
  }

  @Get('sessions')
  @RequirePlatformPermission('platform.activity.view')
  sessions(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Query() query: Record<string, unknown>,
    @Req() request: object,
  ): Promise<PlatformLiveSessionsPageView> {
    return this.service.sessions(actor, query ?? {}, platformRequestContext(request));
  }

  @Delete('sessions/:sessionId')
  @RequirePlatformPermission('platform.people.security')
  @HttpCode(200)
  endSession(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('sessionId') sessionId: string,
    @Body() body: { reason?: unknown },
    @Req() request: object,
  ): Promise<PlatformSessionEndedView> {
    return this.service.endSession(actor, sessionId, body ?? {}, platformRequestContext(request));
  }

  @Get('step-ups')
  @RequirePlatformPermission('platform.activity.view')
  stepUps(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Query() query: Record<string, unknown>,
    @Req() request: object,
  ): Promise<PlatformStepUpsPageView> {
    return this.service.stepUps(actor, query ?? {}, platformRequestContext(request));
  }

  @Get('suspicious')
  @RequirePlatformPermission('platform.activity.view')
  suspicious(
    @Query() query: Record<string, unknown>,
    @Req() request: object,
  ): Promise<PlatformSuspiciousView> {
    return this.service.suspicious(query ?? {}, platformRequestContext(request));
  }
}

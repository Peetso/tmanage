import {
  Body,
  Controller,
  Delete,
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
import {
  CurrentPlatformAdmin,
  PlatformAdminGuard,
  PlatformStepUpExempt,
} from '../platform-admin.guard.js';
import type { PlatformAdminActor } from '../platform-admin.guard.js';
import { RequirePlatformPermission } from '../require-platform-permission.decorator.js';
import type {
  PlatformSupportSessionDetailView,
  PlatformSupportSessionsView,
  StartSupportSessionView,
  SupportSessionService,
} from './support-session.service.js';

export const SUPPORT_SESSION_SERVICE = Symbol.for('tmanage.SupportSessionService');

/**
 * Support mode routes (platform-admin v2 · PA-05, SPEC §5.2 "Support"):
 *
 * - `POST organizations/:id/support-session` `{minutes?, reason?}` — enter (live step-up ≥ 60 s);
 * - `GET support-sessions?open|all&adminId&organizationId` — the C5 list;
 * - `GET support-sessions/:id` — one visit with its newest actions (the banner and exit dialog
 *   poll the admin's own one, so it is step-up exempt for the owner of the session only);
 * - `POST support-sessions/:id/extend` `{minutes}` — live step-up, 8 h cap in total;
 * - `DELETE support-sessions/:id` — exit (own) or end (someone else's; reason required).
 */
@Controller('v1/platform')
@NoTenant()
@UseGuards(PlatformAdminGuard)
export class SupportSessionController {
  constructor(@Inject(SUPPORT_SESSION_SERVICE) private readonly service: SupportSessionService) {}

  @Post('organizations/:id/support-session')
  @RequirePlatformPermission('platform.orgs.enter')
  @HttpCode(201)
  start(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('id') id: string,
    @Body() body: { minutes?: unknown; reason?: unknown },
    @Req() request: object,
  ): Promise<StartSupportSessionView> {
    return this.service.start(actor, id, body ?? {}, platformRequestContext(request));
  }

  @Get('support-sessions')
  @RequirePlatformPermission('platform.activity.view')
  list(
    @Query() query: Record<string, unknown>,
    @Req() request: object,
  ): Promise<PlatformSupportSessionsView> {
    return this.service.list(query ?? {}, platformRequestContext(request));
  }

  @Get('support-sessions/:id')
  @PlatformStepUpExempt()
  detail(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('id') id: string,
    @Req() request: object,
  ): Promise<PlatformSupportSessionDetailView> {
    return this.service.detail(actor, id, platformRequestContext(request));
  }

  @Post('support-sessions/:id/extend')
  @RequirePlatformPermission('platform.orgs.enter')
  @HttpCode(200)
  extend(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('id') id: string,
    @Body() body: { minutes?: unknown },
    @Req() request: object,
  ): Promise<PlatformSupportSessionDetailView> {
    return this.service.extend(actor, id, body ?? {}, platformRequestContext(request));
  }

  @Delete('support-sessions/:id')
  @RequirePlatformPermission('platform.orgs.enter')
  @PlatformStepUpExempt()
  end(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('id') id: string,
    @Body() body: { reason?: unknown },
    @Req() request: object,
  ): Promise<PlatformSupportSessionDetailView> {
    return this.service.end(actor, id, body ?? {}, platformRequestContext(request));
  }
}

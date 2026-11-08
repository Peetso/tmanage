import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
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
import type { AccessReviewService } from './access-review.service.js';

export const PLATFORM_ACCESS_REVIEW_SERVICE = Symbol.for('tmanage.PlatformAccessReviewService');

/**
 * `/v1/platform/team/access-review` — 56-21b, the monthly "who had platform access" review.
 * Same permission as the team screen: who holds platform access is a super admin's question.
 */
@Controller('v1/platform/team/access-review')
@NoTenant()
@UseGuards(PlatformAdminGuard)
export class PlatformAccessReviewController {
  constructor(
    @Inject(PLATFORM_ACCESS_REVIEW_SERVICE) private readonly service: AccessReviewService,
  ) {}

  @Get()
  @RequirePlatformPermission('platform.team.manage')
  review(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Query('month') month: string | undefined,
    @Req() request: object,
    @Query('quarter') quarter?: string,
  ) {
    return this.service.review(actor, { month, quarter }, platformRequestContext(request));
  }

  /** 56-21 (R46 L2): confirm one person's access for a quarter (or month). */
  @Post('confirm')
  @RequirePlatformPermission('platform.team.manage')
  @HttpCode(201)
  confirm(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Body() body: { period?: unknown; userId?: unknown; reason?: unknown },
    @Req() request: object,
  ) {
    return this.service.confirm(actor, body ?? {}, platformRequestContext(request));
  }

  @Post('record')
  @RequirePlatformPermission('platform.team.manage')
  @HttpCode(201)
  record(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Body() body: { month?: unknown; reason?: unknown },
    @Req() request: object,
  ) {
    return this.service.record(actor, body ?? {}, platformRequestContext(request));
  }
}

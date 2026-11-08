import {
  Body,
  Controller,
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
import { CurrentPlatformAdmin, PlatformAdminGuard } from '../platform-admin.guard.js';
import type { PlatformAdminActor } from '../platform-admin.guard.js';
import { RequirePlatformPermission } from '../require-platform-permission.decorator.js';
import type { PlatformGovernanceService } from './governance.service.js';

export const PLATFORM_GOVERNANCE_SERVICE = Symbol.for('tmanage.PlatformGovernanceService');

type Body = Readonly<Record<string, unknown>>;

/**
 * 56-21 (R46 L2) — `/v1/platform/approvals…` (the two-person rule) and
 * `/v1/platform/owner-notices` (a notice to one company owner).
 *
 * - `GET  approvals` — the policy and the last 100 requests (`platform.orgs.lifecycle`).
 * - `POST approvals` — ask for approval of one risky action on one company (`orgs.lifecycle`).
 * - `POST approvals/:id/approve|reject` — another admin decides (`orgs.lifecycle`).
 * - `POST approvals/policy` — turn the rule on or off, with a reason (`team.manage`).
 * - `GET  owner-notices` — sent notices, optionally one company's (`orgs.view`).
 * - `POST owner-notices` — send one (`orgs.edit`).
 */
@Controller('v1/platform')
@NoTenant()
@UseGuards(PlatformAdminGuard)
export class PlatformGovernanceController {
  constructor(
    @Inject(PLATFORM_GOVERNANCE_SERVICE) private readonly service: PlatformGovernanceService,
  ) {}

  @Get('approvals')
  @RequirePlatformPermission('platform.orgs.lifecycle')
  approvals(@CurrentPlatformAdmin() actor: PlatformAdminActor, @Req() request: object) {
    return this.service.approvals(actor, platformRequestContext(request));
  }

  @Post('approvals/policy')
  @HttpCode(200)
  @RequirePlatformPermission('platform.team.manage')
  setPolicy(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Body() body: Body,
    @Req() request: object,
  ) {
    return this.service.setPolicy(actor, body ?? {}, platformRequestContext(request));
  }

  @Post('approvals')
  @HttpCode(201)
  @RequirePlatformPermission('platform.orgs.lifecycle')
  request(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Body() body: Body,
    @Req() request: object,
  ) {
    return this.service.request(actor, body ?? {}, platformRequestContext(request));
  }

  @Post('approvals/:id/approve')
  @HttpCode(200)
  @RequirePlatformPermission('platform.orgs.lifecycle')
  approve(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('id') id: string,
    @Body() body: Body,
    @Req() request: object,
  ) {
    return this.service.decide(actor, id, 'approved', body ?? {}, platformRequestContext(request));
  }

  @Post('approvals/:id/reject')
  @HttpCode(200)
  @RequirePlatformPermission('platform.orgs.lifecycle')
  reject(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('id') id: string,
    @Body() body: Body,
    @Req() request: object,
  ) {
    return this.service.decide(actor, id, 'rejected', body ?? {}, platformRequestContext(request));
  }

  @Get('owner-notices')
  @RequirePlatformPermission('platform.orgs.view')
  notices(@Query() query: Record<string, unknown>, @Req() request: object) {
    return this.service.notices(query ?? {}, platformRequestContext(request));
  }

  @Post('owner-notices')
  @HttpCode(201)
  @RequirePlatformPermission('platform.orgs.edit')
  sendNotice(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Body() body: Body,
    @Req() request: object,
  ) {
    return this.service.sendNotice(actor, body ?? {}, platformRequestContext(request));
  }
}

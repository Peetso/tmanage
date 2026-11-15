import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { Ctx, NoTenant, Public, RequireCapability } from '../../common/http/decorators.js';
import { platformRequestContext } from '../platform-admin/platform-admin.access.js';
import {
  CurrentPlatformAdmin,
  PlatformAdminGuard,
} from '../platform-admin/platform-admin.guard.js';
import type { PlatformAdminActor } from '../platform-admin/platform-admin.guard.js';
import { RequirePlatformPermission } from '../platform-admin/require-platform-permission.decorator.js';
import { PLATFORM_SUPPORT_READ, PLATFORM_SUPPORT_REPLY } from './support.policy.js';
import type { SupportService } from './support.service.js';
import { publishedTargets } from './support-sla.js';

export const SUPPORT_SERVICE = Symbol.for('tmanage.SupportService');

type RequestBody = Readonly<Record<string, unknown>>;

/**
 * 55-17 — `/v1/organizations/:orgSlug/support/threads…`: a person's conversations with the TManage
 * platform team. `work.read` is the route gate (every internal member holds it; clients do not);
 * the service decides which threads the caller may see (own, or all of the org for `org.manage`).
 */
@Controller('v1/organizations/:orgSlug/support/threads')
export class SupportThreadsController {
  constructor(@Inject(SUPPORT_SERVICE) private readonly service: SupportService) {}

  @Get()
  @RequireCapability('work.read')
  async list(@Ctx() context: TenantContext) {
    const [threads, policy] = await Promise.all([
      this.service.list(context),
      this.service.policy(context),
    ]);
    return { threads, policy };
  }

  @Post()
  @HttpCode(201)
  @RequireCapability('work.read')
  create(@Ctx() context: TenantContext, @Body() body: RequestBody) {
    return this.service.create(context, body ?? {});
  }

  @Get(':threadId')
  @RequireCapability('work.read')
  get(@Ctx() context: TenantContext, @Param('threadId') threadId: string) {
    return this.service.get(context, threadId);
  }

  @Post(':threadId/messages')
  @HttpCode(201)
  @RequireCapability('work.read')
  post(
    @Ctx() context: TenantContext,
    @Param('threadId') threadId: string,
    @Body() body: RequestBody,
  ) {
    return this.service.postMessage(context, threadId, body ?? {});
  }

  @Post(':threadId/close')
  @HttpCode(200)
  @RequireCapability('work.read')
  close(@Ctx() context: TenantContext, @Param('threadId') threadId: string) {
    return this.service.close(context, threadId);
  }
}

/**
 * 55-17 — `/v1/platform/support/threads…`: the platform team's support inbox across every
 * organization. Reading needs `platform.orgs.view`; replying and changing status
 * `platform.orgs.edit`. Every write is audited by the service.
 */
@Controller('v1/platform/support/threads')
@NoTenant()
@UseGuards(PlatformAdminGuard)
export class PlatformSupportThreadsController {
  constructor(@Inject(SUPPORT_SERVICE) private readonly service: SupportService) {}

  /** 57-10: `?breached=1` and `?priority=` narrow the queue on the clock computed now. */
  @Get()
  @RequirePlatformPermission(PLATFORM_SUPPORT_READ)
  async list(
    @Req() request: object,
    @Query('breached') breached?: string,
    @Query('priority') priority?: string,
  ) {
    return {
      threads: await this.service.platformList(platformRequestContext(request).correlationId, {
        breached,
        priority,
      }),
    };
  }

  @Get(':threadId')
  @RequirePlatformPermission(PLATFORM_SUPPORT_READ)
  get(@Param('threadId') threadId: string, @Req() request: object) {
    return this.service.platformGet(threadId, platformRequestContext(request).correlationId);
  }

  @Post(':threadId/messages')
  @HttpCode(201)
  @RequirePlatformPermission(PLATFORM_SUPPORT_REPLY)
  reply(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('threadId') threadId: string,
    @Body() body: RequestBody,
    @Req() request: object,
  ) {
    return this.service.platformReply(actor, threadId, body ?? {}, platformRequestContext(request));
  }

  @Post(':threadId/status')
  @HttpCode(200)
  @RequirePlatformPermission(PLATFORM_SUPPORT_REPLY)
  status(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('threadId') threadId: string,
    @Body() body: RequestBody,
    @Req() request: object,
  ) {
    return this.service.platformSetStatus(
      actor,
      threadId,
      body ?? {},
      platformRequestContext(request),
    );
  }
}

/**
 * 57-10 — `GET /v1/public/site/support-targets`: the published response targets (plan → first
 * response, priority → resolution, the team's hours) for the website and the pricing compare row.
 * Static policy data from `support-sla.ts`, no tenant data, so `@Public()` and cacheable.
 */
@Controller('v1/public/site')
export class SupportTargetsController {
  @Get('support-targets')
  @Public()
  @NoTenant()
  @Header('Cache-Control', 'public, max-age=3600')
  targets() {
    return publishedTargets();
  }
}

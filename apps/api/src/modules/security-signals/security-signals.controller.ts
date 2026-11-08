import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import type { TenantContext } from '../../common/database/tenant-context.js';
import {
  Ctx,
  CurrentPrincipal,
  NoTenant,
  RequireCapability,
} from '../../common/http/decorators.js';
import { platformRequestContext } from '../platform-admin/platform-admin.access.js';
import {
  CurrentPlatformAdmin,
  PlatformAdminGuard,
} from '../platform-admin/platform-admin.guard.js';
import type { PlatformAdminActor } from '../platform-admin/platform-admin.guard.js';
import { RequirePlatformPermission } from '../platform-admin/require-platform-permission.decorator.js';
import { SECURITY_SIGNALS_SERVICE } from './security-signals.service.js';
import type {
  AlertRuleView,
  SecuritySignalsService,
  SignalPage,
  SignalView,
} from './security-signals.service.js';

/**
 * 56-23 — `GET /v1/organizations/:orgSlug/admin/security/events?kind&from&cursor&limit`
 * (`audit.read`): the organization's own security signals. Tenant-scoped like every org
 * controller; nothing reads an organization id from the request.
 */
@Controller('v1/organizations/:orgSlug/admin/security')
export class OrganizationSecurityEventsController {
  constructor(@Inject(SECURITY_SIGNALS_SERVICE) private readonly service: SecuritySignalsService) {}

  @Get('events')
  @RequireCapability('audit.read')
  events(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Query('kind') kind: string | undefined,
    @Query('from') from: string | undefined,
    @Query('cursor') cursor: string | undefined,
    @Query('limit') limit: string | undefined,
    @Query('reviewed') reviewed: string | undefined,
  ): Promise<SignalPage> {
    return this.service.organizationEvents(context, principal, {
      kind,
      from,
      cursor,
      limit,
      reviewed,
    });
  }

  /** 0332 (R44 L2) — `POST events/:signalId/reviewed` (`org.security.manage`), write-once. */
  @Post('events/:signalId/reviewed')
  @RequireCapability('org.security.manage')
  @HttpCode(200)
  markReviewed(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('signalId') signalId: string,
  ): Promise<SignalView> {
    return this.service.markReviewed(context, principal, signalId);
  }
}

/**
 * 56-23 — `/v1/platform/alerts`: the rules (list) and one rule's on/off, threshold and cooldown
 * (PUT). `platform.settings.edit` for both — there is no `platform.settings.view` key yet — and,
 * as on every non-exempt platform route, the guard demands a fresh step-up.
 */
@Controller('v1/platform/alerts')
@NoTenant()
@UseGuards(PlatformAdminGuard)
export class PlatformAlertRulesController {
  constructor(@Inject(SECURITY_SIGNALS_SERVICE) private readonly service: SecuritySignalsService) {}

  @Get()
  @RequirePlatformPermission('platform.settings.edit')
  async list(@Req() request: object): Promise<{ readonly rules: readonly AlertRuleView[] }> {
    return { rules: await this.service.rules(platformRequestContext(request)) };
  }

  @Put(':ruleKey')
  @RequirePlatformPermission('platform.settings.edit')
  update(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('ruleKey') ruleKey: string,
    @Body() body: Readonly<Record<string, unknown>> | undefined,
    @Req() request: object,
  ): Promise<AlertRuleView> {
    return this.service.updateRule(actor, ruleKey, body ?? {}, platformRequestContext(request));
  }
}

/** 56-23 — `GET /v1/platform/security-signals?scope=all|platform&kind&from&cursor&limit`. */
@Controller('v1/platform/security-signals')
@NoTenant()
@UseGuards(PlatformAdminGuard)
export class PlatformSecuritySignalsController {
  constructor(@Inject(SECURITY_SIGNALS_SERVICE) private readonly service: SecuritySignalsService) {}

  @Get()
  @RequirePlatformPermission('platform.settings.edit')
  list(
    @Query('scope') scope: string | undefined,
    @Query('kind') kind: string | undefined,
    @Query('from') from: string | undefined,
    @Query('cursor') cursor: string | undefined,
    @Query('limit') limit: string | undefined,
    @Req() request: object,
  ): Promise<SignalPage> {
    return this.service.platformSignals(
      { scope, kind, from, cursor, limit },
      platformRequestContext(request),
    );
  }
}

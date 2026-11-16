import { Body, Controller, Get, HttpCode, Inject, Post, Query } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import type {
  PublicLinkBulkResultView,
  PublicLinkManagerService,
  PublicLinkManagerView,
} from './public-link-manager.service.js';

export const PUBLIC_LINK_MANAGER_SERVICE = Symbol.for('tmanage.PublicLinkManagerService');

/**
 * 56-07p — `/v1/organizations/:orgSlug/public-links/manage`: the workspace's public link list,
 * bulk revoke and new end date (Settings · Public links). The route guard and the service both ask
 * for `org.security.manage`; the service's check is the authoritative one. Never for the AI
 * connector (`NEVER`, `org_security_manage`).
 */
@Controller('v1/organizations/:orgSlug/public-links/manage')
export class PublicLinkManagerController {
  constructor(
    @Inject(PUBLIC_LINK_MANAGER_SERVICE) private readonly manager: PublicLinkManagerService,
  ) {}

  @Get()
  @RequireCapability('org.security.manage')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Query() query: Record<string, unknown>,
  ): Promise<PublicLinkManagerView> {
    return this.manager.list(context, principal, query);
  }

  @Post('revoke')
  @RequireCapability('org.security.manage')
  @HttpCode(200)
  async revoke(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
  ): Promise<PublicLinkBulkResultView> {
    return this.manager.revokeMany(context, principal, body);
  }

  @Post('expiry')
  @RequireCapability('org.security.manage')
  @HttpCode(200)
  async expiry(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
  ): Promise<PublicLinkBulkResultView> {
    return this.manager.changeExpiry(context, principal, body);
  }
}

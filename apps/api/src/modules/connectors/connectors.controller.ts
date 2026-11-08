import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { CONNECTORS_SERVICE } from './connectors.service.js';
import type { ConnectorView, ConnectorsService } from './connectors.service.js';

/**
 * 54-01. The connector framework's routes, owner/admin only (`org.manage`):
 * `GET …/connectors` lists the registry with this workspace's state; `GET …/connectors/:key` is one
 * connector's status; `POST …/connectors/:key/install` stores an API key in the token vault;
 * `DELETE …/connectors/:key` uninstalls and drops the stored credential. The tenant comes from the
 * context, never from the path or a body. All four are on the AI connector's NEVER list.
 */
@Controller('v1/organizations/:orgSlug/connectors')
export class ConnectorsController {
  constructor(@Inject(CONNECTORS_SERVICE) private readonly connectors: ConnectorsService) {}

  @Get()
  @RequireCapability('org.manage')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<{ readonly connectors: readonly ConnectorView[] }> {
    return { connectors: await this.connectors.list(context, principal) };
  }

  @Get(':connectorKey')
  @RequireCapability('org.manage')
  async status(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('connectorKey') connectorKey: string,
  ): Promise<ConnectorView> {
    return this.connectors.status(context, principal, connectorKey);
  }

  @Post(':connectorKey/install')
  @RequireCapability('org.manage')
  @HttpCode(201)
  async install(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('connectorKey') connectorKey: string,
    @Body() body: { apiKey?: unknown } | undefined,
  ): Promise<ConnectorView> {
    return this.connectors.install(context, principal, connectorKey, body ?? {});
  }

  @Delete(':connectorKey')
  @RequireCapability('org.manage')
  @HttpCode(200)
  async uninstall(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('connectorKey') connectorKey: string,
  ): Promise<ConnectorView> {
    return this.connectors.uninstall(context, principal, connectorKey);
  }
}

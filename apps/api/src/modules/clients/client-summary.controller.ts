import { Controller, Get, Inject, Param } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { CLIENT_SUMMARY_SERVICE } from './client-summary.service.js';
import type { ClientSummaryService, ClientSummaryView } from './client-summary.service.js';

/**
 * ONEPAGE (B01). `GET …/client-organizations/:clientOrganizationId/summary` — the client page's one
 * read. `org.manage` is the ceiling the client detail page already uses; the service authorises the
 * company (404 when foreign), then each block. The organization comes from the verified
 * `TenantContext`, never from the path or a body.
 */
@Controller('v1/organizations/:orgSlug/client-organizations/:clientOrganizationId/summary')
export class ClientSummaryController {
  constructor(@Inject(CLIENT_SUMMARY_SERVICE) private readonly summaries: ClientSummaryService) {}

  @Get()
  @RequireCapability('org.manage')
  get(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('clientOrganizationId') clientOrganizationId: string,
  ): Promise<ClientSummaryView> {
    return this.summaries.get(context, principal, clientOrganizationId);
  }
}

import { Controller, Get, Inject, Param } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { INSIGHTS_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { DeliveryFlowView, InsightsService } from './insights.service.js';

/**
 * INS-01's HTTP surface — the insights module's first read.
 *
 * `work.read` on the route, the internal-read capability x86's project-health roll-up reuses (see
 * the service's note). A caller without it is refused by the global `CapabilityGuard` exactly as
 * the sibling `work-items` reads are — this is not a second copy of that check, it is the same
 * guard reading the same capability off this route's metadata.
 *
 * The module is read-only this slice, so there is no `POST`/`PATCH` here. A dedicated
 * `/insights` web surface is the follow-up (recorded in implementation-status); nothing consumes
 * this endpoint yet, which is why its view is exempt in `scripts/contracts-check.mjs`.
 */
@Controller('v1/organizations/:orgSlug/insights')
export class InsightsController {
  constructor(@Inject(INSIGHTS_SERVICE) private readonly insights: InsightsService) {}

  /**
   * A project's delivery flow — work-item counts by workflow status. Tenant-scoped by `orgSlug`
   * (the `TenantContextGuard`), authorized per item by the service.
   */
  @Get('projects/:projectId/delivery-flow')
  @RequireCapability('work.read')
  async deliveryFlow(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
  ): Promise<DeliveryFlowView> {
    return this.insights.projectDeliveryFlow(context, principal, projectId);
  }
}

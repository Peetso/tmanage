import { Controller, Get, Inject, Param } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { INSIGHTS_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { ApprovalCycleView, DeliveryFlowView, InsightsService } from './insights.service.js';

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

  /**
   * A project's approval cycle — approval counts by terminal outcome and, for the decided ones,
   * the requested→decided durations. Behind `approval.read`, x92's approvals capability: a caller
   * without it is refused by the same `CapabilityGuard` that refuses the sibling `approvals`
   * reads. Tenant-scoped by `orgSlug`, authorized per approval by the service.
   */
  @Get('projects/:projectId/approval-cycle')
  @RequireCapability('approval.read')
  async approvalCycle(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
  ): Promise<ApprovalCycleView> {
    return this.insights.projectApprovalCycle(context, principal, projectId);
  }
}

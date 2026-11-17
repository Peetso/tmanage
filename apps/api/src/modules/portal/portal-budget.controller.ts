import { Controller, Get, Inject, Param } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import {
  BUDGET_BURN_SERVICE,
  type BudgetBurnService,
  type PortalBudgetView,
} from '../projects/budget-burn.service.js';
import { RequireFeature } from '../admin/feature-gate.js';

/**
 * 52-05 (R16-b) — the client's view of a project's budget, on the `/portal` path.
 *
 * `client_projection.read` and the project shared with the client's organization, and only when the
 * team switched "Show to client" on (`client_visible = 1`); otherwise 404, the same answer as an
 * unknown project. The body is the dedicated three-field projection `{percentUsed, remainingHours?,
 * status}` (25 §7): never an amount, a rate, a cost or a minor-unit figure, and never a name.
 */
@RequireFeature('client_invoicing')
@Controller('v1/organizations/:orgSlug/portal/projects')
export class PortalBudgetController {
  constructor(@Inject(BUDGET_BURN_SERVICE) private readonly burns: BudgetBurnService) {}

  @Get(':projectId/budget')
  @RequireCapability('client_projection.read')
  async get(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
  ): Promise<PortalBudgetView> {
    return this.burns.portalProjection(context, principal, projectId);
  }
}

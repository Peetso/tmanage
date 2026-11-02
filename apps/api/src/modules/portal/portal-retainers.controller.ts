import { Controller, Get, Inject, Param } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { RETAINERS_SERVICE } from '../finance/retainers.controller.js';
import type {
  PortalRetainerSummary,
  PortalRetainerView,
  RetainersService,
} from '../finance/retainers.service.js';

/**
 * 52-06 — the client's view of its retainers, on the `/portal` path (registered in the finance
 * module beside the service it reads, as the budget projection is in the budget module).
 *
 * `client_projection.read`, the retainer's client organization = the principal's own, and only
 * when the team left "Show to client" on (`client_visible = 1`); otherwise 404, the same answer as
 * an unknown retainer. The body is the dedicated projection `{name, periodStart, periodEnd,
 * allowanceHours, usedHours, remainingHours, renewsOn, entries:[{date, taskTitle, hours}]}` (25 §7):
 * no person, no amount, rate or cost, and an internal item's title reads "Internal work".
 */
@Controller('v1/organizations/:orgSlug/portal/retainers')
export class PortalRetainersController {
  constructor(@Inject(RETAINERS_SERVICE) private readonly retainers: RetainersService) {}

  @Get()
  @RequireCapability('client_projection.read')
  list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<{ readonly retainers: readonly PortalRetainerSummary[] }> {
    return this.retainers.portalList(context, principal);
  }

  @Get(':retainerId')
  @RequireCapability('client_projection.read')
  get(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('retainerId') retainerId: string,
  ): Promise<PortalRetainerView> {
    return this.retainers.portalGet(context, principal, retainerId);
  }
}

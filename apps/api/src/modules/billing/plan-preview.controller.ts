import { Controller, Get, Inject, Query } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { PLAN_PREVIEW_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { PlanChangePreviewView, PlanPreviewService } from './plan-preview.service.js';

/**
 * Billing / module 19 (x198). A read-only preview of what changing plan would cost, before the owner
 * commits the change x177 records. Mounted at `…/organizations/:orgSlug/billing/plan-change`,
 * org-scoped (no `:projectId`).
 *
 * Gated on `org.manage` — the same owners-only population the subscription routes sit behind; there is
 * no dedicated `billing.*` capability, so this reuses `org.manage` (no `capabilities.ts` edit). Like
 * every tenant-scoped controller here it never reads `organizationId` from the query, a header or its
 * own `:orgSlug` segment: it passes on the {@link TenantContext} the guard built from a membership
 * row. `target` and `seats` are validated at the boundary and re-validated in the service, which also
 * re-checks authorization. Nothing is written and nothing is charged — this is an estimate.
 */
@Controller('v1/organizations/:orgSlug/billing/plan-change')
export class PlanPreviewController {
  constructor(@Inject(PLAN_PREVIEW_SERVICE) private readonly plans: PlanPreviewService) {}

  /**
   * Estimate the cost of moving to `target` at `seats` seats (default 1). The service returns a 400
   * for an off-catalog `target` or a seat count outside `[1, 1000]`, a 403 without `org.manage`, and
   * otherwise the deterministic delta against the tenant's current subscription.
   */
  @Get('preview')
  @RequireCapability('billing.view')
  async preview(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Query('target') target?: string,
    @Query('seats') seats?: string,
  ): Promise<PlanChangePreviewView> {
    // `seats` defaults to one occupied seat; an explicit non-integer becomes NaN and the service
    // turns it into the ordinary 400 rather than a silent default.
    const parsedSeats = seats === undefined ? 1 : Number(seats);
    return this.plans.preview(context, principal, {
      target: typeof target === 'string' ? target.trim() : '',
      seats: parsedSeats,
    });
  }
}

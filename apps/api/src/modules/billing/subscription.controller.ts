import { Body, Controller, Get, Inject, Post } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { SUBSCRIPTION_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { SubscriptionService, SubscriptionView } from './subscription.service.js';

/**
 * Billing / module 19 (x177). The organization's current subscription: view it, and request a plan
 * change. Mounted at `…/organizations/:orgSlug/billing/subscription`, org-scoped (no `:projectId`).
 *
 * Both routes are gated on `org.manage` — the same owners-only population the storage/usage read
 * (USAGE-001 slice 5) sits behind; there is no dedicated `billing.*` capability, so this reuses
 * `org.manage` rather than inventing one (no `capabilities.ts` edit). Like every tenant-scoped
 * controller here, it never reads `organizationId` from the body, a header, or its own `:orgSlug`
 * segment: it receives the `TenantContext` that `TenantContextGuard` built from a membership row and
 * passes it on. Authorization is re-checked in the service (defence in depth, `25` §3).
 */

interface ChangePlanBody {
  readonly planId?: unknown;
}

@Controller('v1/organizations/:orgSlug/billing/subscription')
export class SubscriptionController {
  constructor(@Inject(SUBSCRIPTION_SERVICE) private readonly subscription: SubscriptionService) {}

  /** The current plan, its status and renewal date — defaulting to the free/base tier if none. */
  @Get()
  @RequireCapability('org.manage')
  async read(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<SubscriptionView> {
    return this.subscription.read(context, principal);
  }

  /**
   * Request a change to a catalog plan. The target must be a non-empty string; an off-catalog id is
   * a 400 in the service (with no write). The change is recorded as `pending_change` — **no payment
   * is executed here** (real charging is Needs-Peter).
   */
  @Post('change')
  @RequireCapability('org.manage')
  async change(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: ChangePlanBody,
  ): Promise<SubscriptionView> {
    const planId = typeof body?.planId === 'string' ? body.planId.trim() : '';
    if (planId === '') {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: 'planId', message: 'must be a non-empty string' },
      ]);
    }
    return this.subscription.requestChange(context, principal, planId);
  }
}

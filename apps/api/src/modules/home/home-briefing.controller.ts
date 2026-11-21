import { Controller, Get, Inject, Param } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { RequireFeature } from '../admin/feature-gate.js';
import type {
  BriefingSignalView,
  HomeBriefingService,
  HomeBriefingView,
} from './home-briefing.service.js';

/** DI token for the briefing service (provided by `HomeModule`). */
export const HOME_BRIEFING_SERVICE = Symbol.for('tmanage.HomeBriefingService');

/**
 * 62-A1b (B11) — `GET /v1/organizations/:orgSlug/home/briefing`.
 *
 * The route exists only while the company's `business_briefing` flag is on (off is the calm 404
 * of `feature-gate.ts`). Its ceiling is `approval.read`, the one capability every principal
 * holds, so the guard admits everyone and the service — not a 403 — answers clients and internal
 * guests with the same 404: a refusal never confirms there is a briefing to refuse. Who sees which
 * line is the service's per-row rule (owner/admin the company, a lead their projects, money with
 * `finance.view`).
 */
@Controller('v1/organizations/:orgSlug/home/briefing')
@RequireFeature('business_briefing')
export class HomeBriefingController {
  constructor(@Inject(HOME_BRIEFING_SERVICE) private readonly briefing: HomeBriefingService) {}

  @Get()
  @RequireCapability('approval.read')
  read(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<HomeBriefingView> {
    return this.briefing.briefingOf(context, principal);
  }

  /**
   * 62-28 — `GET …/home/briefing/signals/:signalId`: one open alert with its figures and reason,
   * for "Explain this alert" (the chat's `explain_signal` tool). Same gate and same per-signal
   * rule as the card; anything the viewer may not see is 404.
   */
  @Get('signals/:signalId')
  @RequireCapability('approval.read')
  signal(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('signalId') signalId: string,
  ): Promise<BriefingSignalView> {
    return this.briefing.signalOf(context, principal, signalId);
  }
}

import { Controller, Get, Inject } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { HOME_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { HomeService, MyDayView, WaitingView } from './home.service.js';

/**
 * HOME-03's HTTP surface — the My Day personal-work read.
 *
 * The same shape as `WorkItemsController`: it reads no `organizationId` from anywhere, because
 * `TenantContextGuard` built the `TenantContext` from a membership row, and it names the acting
 * user by the `Principal` the session resolved, never by a field a caller could supply.
 *
 * Behind `work.read`, the capability every work read uses — reused rather than a new `home.read`
 * so this slice stays off `capabilities.ts` and the role grid (a dedicated capability is the
 * clean follow-up once the module grows). A caller without `work.read` is refused here exactly
 * as the sibling work reads refuse.
 */
@Controller('v1/organizations/:orgSlug/home')
export class HomeController {
  constructor(@Inject(HOME_SERVICE) private readonly home: HomeService) {}

  @Get('my-day')
  @RequireCapability('work.read')
  async myDay(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<MyDayView> {
    return this.home.myDayOf(context, principal);
  }

  /**
   * HOME-04's Waiting read — the approvals pending on the acting user as a reviewer.
   *
   * `@RequireCapability('approval.read')` is the coarse route ceiling, UX only
   * (`25-AUTH-AND-TENANT-ISOLATION` §3), exactly as `ApprovalsController` guards its routes: it
   * admits the roles that could plausibly touch an approval and answers nothing about *which*
   * approvals. The real gate — is this principal an assigned reviewer on the row — is the
   * service's, built from each approval's `reviewer_ids` (AUTH-08). A caller without
   * `approval.read` is refused here as the sibling approval reads refuse.
   *
   * The delegated bucket is scoped out (no creator/assignee column on `work_items`), so `work.read`
   * — the brief's second capability — does not gate this approvals-only read; it returns once the
   * delegated bucket lands.
   */
  @Get('waiting')
  @RequireCapability('approval.read')
  async waiting(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<WaitingView> {
    return this.home.waitingOf(context, principal);
  }
}

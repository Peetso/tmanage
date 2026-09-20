import { Controller, Get, Inject } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { HOME_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { HomeService, MyDayView } from './home.service.js';

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
}

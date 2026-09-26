import { Controller, Get, Inject } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { HomePulseService } from './home-pulse.service.js';
import type { HomePulseView } from './home-pulse.service.js';

/**
 * HOME-01's Pulse/Focus HTTP surface — one read of the acting user's headline counts.
 *
 * A distinct controller from {@link HomeController} so this slice touches no existing home file; it
 * shares the same `/home` base path with a new `pulse` leaf. Behind `work.read`, the capability
 * every Home read reuses (no `home.read`, so this slice stays off `capabilities.ts` and the role
 * grid): a client principal — who has no `work.read` and no business with an internal Home Focus —
 * is refused here exactly as the sibling home reads refuse. It reads no `organizationId` and no
 * `userId` from anywhere: the tenant is `TenantContextGuard`'s, and the acting user is the session's.
 */
@Controller('v1/organizations/:orgSlug/home')
export class HomePulseController {
  constructor(@Inject(HomePulseService) private readonly pulse: HomePulseService) {}

  @Get('pulse')
  @RequireCapability('work.read')
  async pulseSummary(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<HomePulseView> {
    return this.pulse.pulseOf(context, principal);
  }
}

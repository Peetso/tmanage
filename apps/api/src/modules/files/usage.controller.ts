import { Controller, Get, Inject } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { USAGE_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { UsageService, UsageView } from './usage.service.js';

/**
 * USAGE-001 slice 5's HTTP surface — the billing screen's read (`49-…` §8).
 *
 * One ordinary tenant-scoped route behind the four guards, following the invitations/session
 * controllers: `@Ctx()` carries the tenant the guard resolved from an active membership, and the
 * organization the counter is read for is `context.organizationId` — the path's `:orgSlug` is
 * matched against that membership by `TenantContextGuard`, never trusted as the tenant. There is
 * no body and no organization-id parameter, so the caller cannot name another tenant's usage.
 *
 * The response is exactly {@link UsageView} — `{ used, previews, reserved, quota, unit, reconciledAt }` — so
 * the screen renders it directly; it is not wrapped in an envelope.
 */
@Controller('v1/organizations/:orgSlug/usage')
export class UsageController {
  constructor(@Inject(USAGE_SERVICE) private readonly usage: UsageService) {}

  /**
   * DIVERGENCE — AUTH-16 name pending. `49-…` §8 imagines a dedicated billing/usage capability,
   * but none exists in code (implementation-status question 7), so this reuses `org.manage`:
   * owners, the same population the threshold notice reaches. A refusal here is the guard's
   * standard 403 `forbidden` — the same envelope as every sibling, with no leak of the reason.
   */
  @Get()
  @RequireCapability('org.manage')
  async read(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<UsageView> {
    return this.usage.read(context, principal);
  }
}

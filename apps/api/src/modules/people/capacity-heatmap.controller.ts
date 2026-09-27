import { Controller, Get, Inject, Query } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { CAPACITY_HEATMAP_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { parseHeatmapQuery } from './capacity-heatmap.service.js';
import type { CapacityHeatmapService, CapacityHeatmapView } from './capacity-heatmap.service.js';

/**
 * Team capacity heatmap (module 14, x193). One read endpoint: the org-level member × week utilisation
 * grid folded from the existing `person_capacity` (x170) and `person_allocations` (x171) facts.
 *
 * ## Authorization
 *
 * `CapabilityGuard` on the route asks the coarse `work.read` question (the internal-read capability the
 * people directory reuses). The service adds the authoritative org-scoped `authorize()` (deny-by-default)
 * the guard cannot make, so a client principal — who never holds the internal-only `work.read` — is a
 * 403. Every read is tenant-scoped in the repository.
 *
 * ## The Known-trap
 *
 * The window (`from`, `weeks`) is validated and bounded BEFORE any read: `from` must be an ISO date and
 * `weeks` an integer in `[1, MAX_WEEKS]`. An absurd or malformed range is a 400 with no read, so the
 * aggregation can never fan out into an unbounded tenant-wide scan.
 */
@Controller('v1/organizations/:orgSlug/people/capacity/heatmap')
export class CapacityHeatmapController {
  constructor(@Inject(CAPACITY_HEATMAP_SERVICE) private readonly service: CapacityHeatmapService) {}

  @Get()
  @RequireCapability('work.read')
  async read(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Query('from') from?: string,
    @Query('weeks') weeks?: string,
  ): Promise<CapacityHeatmapView> {
    const query = parseHeatmapQuery(from, weeks);
    return this.service.build(context, principal, query);
  }
}

import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { PersonLoadService } from './person-load.service.js';
import type { PersonLoadView } from './person-load.service.js';

/**
 * 53-08 (R20-b) — one person's weekly load: `GET …/people/:membershipId/load?from&to`.
 *
 * Capabilities: `people.view` is not a capability key, so the read sits behind `work.read` (as the
 * capacity heatmap does); the service adds the org-scoped `authorize()` and a client principal is a
 * 403. Allocation create/confirm stay `project.manage` (allocations.controller.ts). The window is
 * `from`..`to` (ISO dates, both required, ≤ 26 Monday-start weeks, else 400 before any read). The
 * aggregate is computed per reader: work the reader may not read appears only as
 * `otherProjectsHours`, rounded to 0.5 h, with no project id or title.
 */
@Controller('v1/organizations/:orgSlug/people/:membershipId/load')
export class PersonLoadController {
  constructor(@Inject(PersonLoadService) private readonly service: PersonLoadService) {}

  @Get()
  @RequireCapability('work.read')
  async read(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('membershipId') membershipId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<PersonLoadView> {
    return this.service.load(context, principal, membershipId, from, to);
  }
}

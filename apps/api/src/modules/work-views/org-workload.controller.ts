import { Controller, Get, Inject, Query } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { OrgWorkloadService } from './org-workload.service.js';
import type { OrgWorkloadResponse } from './org-workload.service.js';

/**
 * 53-08 part 2a (R21-a) — the org-wide workload grid:
 * `GET …/work-views/workload?scope=org|project:<id>&from&to&cursor`. People rows (a page of 50,
 * keyset `cursor`) × Monday-start week columns (`from`/`to` ISO dates, both required, ≤ 26 weeks),
 * plus an Unassigned row. The old per-project `GET work-views/workload/:projectId` stays as it is.
 *
 * Capabilities: `people.view` is not a key, so the read sits behind `work.read`; the service adds the
 * org-scoped `authorize()` (a client principal is a 403; clients have no route). Work the reader may
 * not read appears only as each person's `otherProjectsHours` (0.5 h), never by id or title. There
 * is no `zoom` parameter: the web zooms client-side over these week buckets. No score, no ranking.
 */
@Controller('v1/organizations/:orgSlug/work-views')
export class OrgWorkloadController {
  constructor(@Inject(OrgWorkloadService) private readonly service: OrgWorkloadService) {}

  @Get('workload')
  @RequireCapability('work.read')
  async grid(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Query('scope') scope?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('cursor') cursor?: string,
  ): Promise<OrgWorkloadResponse> {
    return this.service.grid(context, principal, { scope, from, to, cursor });
  }
}

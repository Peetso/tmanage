import { Controller, Get, Inject, Param } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { WORK_VIEWS_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { WorkTimelineView, WorkViewsService } from './work-views.service.js';

/**
 * WK-04's HTTP surface — the Work views read layer.
 *
 * The same shape and the same tenant rule as `WorkItemsController`: no `organizationId` is read
 * from anywhere, because `TenantContextGuard` built the `TenantContext` and there is no field
 * for a caller to supply one.
 *
 * Behind `@RequireCapability('work.read')` — the sibling work reads' capability, **reused** so
 * this slice stays off `capabilities.ts`/`role-operation-grid.ts` (a dedicated work-views
 * capability is the follow-up; NEXT-SCOPES §x94). A caller without `work.read` is refused by the
 * global `CapabilityGuard` exactly as `GET .../work-items` refuses them.
 */
@Controller('v1/organizations/:orgSlug/work-views')
export class WorkViewsController {
  constructor(@Inject(WORK_VIEWS_SERVICE) private readonly workViews: WorkViewsService) {}

  /**
   * A project's work items with their dates and predecessor edges, ordered for a timeline. A
   * pure read composed from the existing work + work-graph reads; nothing here writes.
   */
  @Get('timeline/:projectId')
  @RequireCapability('work.read')
  async timeline(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
  ): Promise<WorkTimelineView> {
    return this.workViews.projectTimeline(context, principal, projectId);
  }
}

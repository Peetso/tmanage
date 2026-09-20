import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { WORK_VIEWS_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { WorkCalendarView, WorkTimelineView, WorkViewsService } from './work-views.service.js';

/** A calendar range is bounded by `YYYY-MM-DD` date-only strings; the day is the calendar bucket. */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Validate a `YYYY-MM-DD` query value, adding a field error rather than throwing on a bad one. */
function parseDay(
  field: string,
  raw: unknown,
  details: { field: string; message: string }[],
): string | undefined {
  if (
    typeof raw !== 'string' ||
    !DATE_ONLY.test(raw) ||
    Number.isNaN(Date.parse(`${raw}T00:00:00Z`))
  ) {
    details.push({ field, message: 'must be a YYYY-MM-DD date' });
    return undefined;
  }
  return raw;
}

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

  /**
   * A project's open work items bucketed by date into a calendar grid over a requested range. A
   * pure read composed from the existing work read; nothing here writes. `from`/`to` are required
   * `YYYY-MM-DD` days, both ends inclusive — an unbounded calendar is not a calendar.
   */
  @Get('calendar/:projectId')
  @RequireCapability('work.read')
  async calendar(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<WorkCalendarView> {
    const details: { field: string; message: string }[] = [];
    const parsedFrom = parseDay('from', from, details);
    const parsedTo = parseDay('to', to, details);
    if (parsedFrom && parsedTo && parsedFrom > parsedTo) {
      details.push({ field: 'to', message: 'must be on or after from' });
    }
    if (details.length > 0 || !parsedFrom || !parsedTo) {
      throw new ApiError(400, 'validation_failed', 'The date range is invalid', details);
    }

    return this.workViews.projectCalendar(context, principal, projectId, {
      from: parsedFrom,
      to: parsedTo,
    });
  }
}

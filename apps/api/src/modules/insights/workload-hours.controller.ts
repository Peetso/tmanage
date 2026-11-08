import { Body, Controller, Get, Inject, Param, Put } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { WorkloadHoursService } from './workload-hours.service.js';
import type { WorkloadCapacityView, WorkloadHoursView } from './workload-hours.service.js';

/**
 * A14's HTTP surface — workload in hours, and the owner/admin capacity write.
 *
 * `GET  …/insights/workload-hours` — `report.view` (the forecast's capability).
 * `PUT  …/insights/workload-hours/capacity/:membershipId` — `org.manage` (owner and org admin only),
 * re-checked in the service after the member is resolved tenant-scoped.
 */
@Controller('v1/organizations/:orgSlug/insights/workload-hours')
export class WorkloadHoursController {
  constructor(@Inject(WorkloadHoursService) private readonly workload: WorkloadHoursService) {}

  @Get()
  @RequireCapability('report.view')
  async read(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<WorkloadHoursView> {
    return this.workload.view(context, principal);
  }

  @Put('capacity/:membershipId')
  @RequireCapability('org.manage')
  async setCapacity(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('membershipId') membershipId: string,
    @Body() body: { readonly weeklyHours?: unknown } | undefined,
  ): Promise<WorkloadCapacityView> {
    if (typeof membershipId !== 'string' || membershipId === '') {
      throw new ApiError(400, 'validation_failed', 'membershipId is required', [
        { field: 'membershipId', message: 'must be a non-empty string' },
      ]);
    }
    return this.workload.setCapacity(context, principal, membershipId, body?.weeklyHours);
  }
}

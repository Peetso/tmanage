import { Controller, Get, Inject, Param } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { PortalJourney } from './portal-journey.js';
import { PortalJourneyService } from './portal-journey.service.js';

@Controller('v1/organizations/:orgSlug/portal')
export class PortalJourneyController {
  constructor(@Inject(PortalJourneyService) private readonly journeys: PortalJourneyService) {}

  /**
   * 52-27 — the portal home stepper: published milestones as steps, and the one review the
   * client owes now. `client_projection.read`; a project the caller cannot read is a `404`.
   */
  @Get('projects/:projectId/journey')
  @RequireCapability('client_projection.read')
  async journey(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
  ): Promise<{ readonly journey: PortalJourney }> {
    return { journey: await this.journeys.forProject(context, principal, projectId) };
  }
}

import { Body, Controller, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { PublicFormDefinition } from '../public-forms/public-forms.validate.js';
import type { PortalJourney } from './portal-journey.js';
import { PortalJourneyService } from './portal-journey.service.js';

@Controller('v1/organizations/:orgSlug/portal')
export class PortalJourneyController {
  constructor(@Inject(PortalJourneyService) private readonly journeys: PortalJourneyService) {}

  /**
   * 52-27 — the portal home stepper: the client's journey steps and published milestones, and the
   * one action the client owes now. `client_projection.read`; a project the caller cannot read is
   * a `404`.
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

  /** 52-27 — the form a form step shows; another client's step or an unknown id is a `404`. */
  @Get('journey-steps/:stepId/form')
  @RequireCapability('client_projection.read')
  form(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('stepId') stepId: string,
  ): Promise<PublicFormDefinition> {
    return this.journeys.formDefinition(context, principal, stepId);
  }

  /** 52-27 — send a form step's answers; the server stores them and marks the step from them. */
  @Post('journey-steps/:stepId/form')
  @RequireCapability('client_request.submit')
  @HttpCode(201)
  submit(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('stepId') stepId: string,
    @Body() body: { readonly values?: unknown } | undefined,
  ): Promise<{ readonly reference: string }> {
    return this.journeys.submitForm(context, principal, stepId, body?.values);
  }
}

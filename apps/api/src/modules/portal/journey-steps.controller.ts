import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { JOURNEY_STEPS_SERVICE } from './journey-steps.service.js';
import type {
  JourneyStepView,
  JourneyStepsService,
  JourneyTemplateView,
} from './journey-steps.service.js';

type StepBody = Readonly<Record<string, unknown>> | undefined;

/**
 * 52-27 — the studio lays out a client's journey on a project: list, add, rename or link, remove,
 * and apply a journey template from an installed pack. All `project.manage`; the service
 * re-checks the project relation and answers `404` for a project the caller cannot manage.
 */
@Controller('v1/organizations/:orgSlug')
export class JourneyStepsController {
  constructor(@Inject(JOURNEY_STEPS_SERVICE) private readonly steps: JourneyStepsService) {}

  @Get('projects/:projectId/journey-steps')
  @RequireCapability('project.manage')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
  ): Promise<{ readonly steps: readonly JourneyStepView[] }> {
    return { steps: await this.steps.list(context, principal, projectId) };
  }

  @Post('projects/:projectId/journey-steps')
  @RequireCapability('project.manage')
  @HttpCode(201)
  create(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
    @Body() body: StepBody,
  ): Promise<JourneyStepView> {
    return this.steps.create(context, principal, projectId, body ?? {});
  }

  @Post('projects/:projectId/journey-steps/from-template')
  @RequireCapability('project.manage')
  @HttpCode(201)
  async fromTemplate(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
    @Body() body: StepBody,
  ): Promise<{ readonly steps: readonly JourneyStepView[] }> {
    return { steps: await this.steps.applyTemplate(context, principal, projectId, body ?? {}) };
  }

  @Patch('projects/:projectId/journey-steps/:stepId')
  @RequireCapability('project.manage')
  update(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
    @Param('stepId') stepId: string,
    @Body() body: StepBody,
  ): Promise<JourneyStepView> {
    return this.steps.update(context, principal, projectId, stepId, body ?? {});
  }

  @Delete('projects/:projectId/journey-steps/:stepId')
  @RequireCapability('project.manage')
  @HttpCode(204)
  async remove(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
    @Param('stepId') stepId: string,
  ): Promise<void> {
    await this.steps.remove(context, principal, projectId, stepId);
  }

  /** The journey templates the studio's installed packs offer. */
  @Get('journey-templates')
  @RequireCapability('project.manage')
  async templates(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<{ readonly templates: readonly JourneyTemplateView[] }> {
    return { templates: await this.steps.templates(context, principal) };
  }
}

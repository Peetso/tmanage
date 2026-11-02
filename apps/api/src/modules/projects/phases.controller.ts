import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Put } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { PROJECT_PHASES_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type {
  MilestonePhaseAssignmentView,
  PhaseDatesInput,
  ProjectPhaseView,
  ProjectPhasesService,
} from './phases.service.js';

/**
 * PROJ / module 8 (x294). A project's timeline **phases**: define, list, delete a phase, and assign
 * a milestone to a phase.
 *
 * Mounted at the org-level base so the four routes can sit where the brief puts them
 * (`projects/:projectId/phases`, `phases/:phaseId`, `milestones/:milestoneId/phase/:phaseId`). Every
 * write is gated on `project.manage`, and the service resolves each id tenant-scoped before it
 * authorizes or writes (Known-trap) — an unknown or cross-tenant id is a 404, never a foreign-key
 * 500. Like every tenant-scoped controller here, it never reads `organizationId` from the body, a
 * header, or its own `:orgSlug` segment.
 */

interface CreatePhaseBody {
  readonly name?: unknown;
  readonly position?: unknown;
}

/** `project_phases.name` is `VARCHAR(200)`. */
const MAX_NAME_LENGTH = 200;

/** 53-07. A civil day. */
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** 53-07. A design-token name (`project_phases.color_token` is `VARCHAR(32)`), never a raw value. */
const COLOR_TOKEN_PATTERN = /^[a-z][a-z0-9.-]{0,31}$/;

/** 53-07. Parse `{startsOn, endsOn, colorToken}`; each is required and may be null. */
export function parsePhaseDatesBody(body: unknown): PhaseDatesInput {
  const record = (body ?? {}) as Record<string, unknown>;
  const details: { field: string; message: string }[] = [];
  const day = (field: 'startsOn' | 'endsOn'): string | null => {
    const raw = record[field];
    if (raw === null || raw === undefined) return null;
    if (typeof raw === 'string' && DAY_PATTERN.test(raw)) return raw;
    details.push({ field, message: 'must be a YYYY-MM-DD date or null' });
    return null;
  };
  const startsOn = day('startsOn');
  const endsOn = day('endsOn');
  const rawColor = record['colorToken'];
  let colorToken: string | null = null;
  if (rawColor !== null && rawColor !== undefined) {
    if (typeof rawColor === 'string' && COLOR_TOKEN_PATTERN.test(rawColor)) colorToken = rawColor;
    else details.push({ field: 'colorToken', message: 'must be a design-token name or null' });
  }
  if (startsOn !== null && endsOn !== null && endsOn < startsOn) {
    details.push({ field: 'endsOn', message: 'must be on or after startsOn' });
  }
  if (details.length > 0) {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
  }
  return { startsOn, endsOn, colorToken };
}

@Controller('v1/organizations/:orgSlug')
export class ProjectPhasesController {
  constructor(@Inject(PROJECT_PHASES_SERVICE) private readonly phases: ProjectPhasesService) {}

  @Get('projects/:projectId/phases')
  @RequireCapability('project.manage')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
  ): Promise<{ readonly phases: readonly ProjectPhaseView[] }> {
    if (typeof projectId !== 'string' || projectId === '') {
      throw new ApiError(400, 'validation_failed', 'projectId is required', [
        { field: 'projectId', message: 'must be a non-empty string' },
      ]);
    }
    return { phases: await this.phases.list(context, principal, projectId) };
  }

  @Post('projects/:projectId/phases')
  @RequireCapability('project.manage')
  @HttpCode(201)
  async create(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
    @Body() body: CreatePhaseBody,
  ): Promise<ProjectPhaseView> {
    if (typeof projectId !== 'string' || projectId === '') {
      throw new ApiError(400, 'validation_failed', 'projectId is required', [
        { field: 'projectId', message: 'must be a non-empty string' },
      ]);
    }

    const name = typeof body?.name === 'string' ? body.name.trim() : undefined;
    const positionProvided = body?.position !== undefined;
    const position = positionProvided ? Number(body?.position) : 0;

    const details = [
      ...(name ? [] : [{ field: 'name', message: 'must be a non-empty string' }]),
      ...(name && name.length > MAX_NAME_LENGTH
        ? [{ field: 'name', message: `must be ${MAX_NAME_LENGTH} characters or fewer` }]
        : []),
      ...(positionProvided && (!Number.isSafeInteger(position) || position < 0)
        ? [{ field: 'position', message: 'must be a non-negative integer' }]
        : []),
    ];
    if (details.length > 0 || !name) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
    }

    return this.phases.define(context, principal, { projectId, name, position });
  }

  /**
   * 53-07. Set a phase's band dates and colour. `project.manage`; definition rows only (an
   * assignment row's id is a 404). Feeds the client timeline, so the AI surface never drives it.
   */
  @Put('projects/:projectId/phases/:phaseId/dates')
  @RequireCapability('project.manage')
  async setDates(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
    @Param('phaseId') phaseId: string,
    @Body() body: unknown,
  ): Promise<ProjectPhaseView> {
    return this.phases.setDates(context, principal, projectId, phaseId, parsePhaseDatesBody(body));
  }

  @Delete('phases/:phaseId')
  @RequireCapability('project.manage')
  @HttpCode(204)
  async remove(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('phaseId') phaseId: string,
  ): Promise<void> {
    if (typeof phaseId !== 'string' || phaseId === '') {
      throw new ApiError(400, 'validation_failed', 'phaseId is required', [
        { field: 'phaseId', message: 'must be a non-empty string' },
      ]);
    }
    await this.phases.deletePhase(context, principal, phaseId);
  }

  @Put('milestones/:milestoneId/phase/:phaseId')
  @RequireCapability('project.manage')
  async assign(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('milestoneId') milestoneId: string,
    @Param('phaseId') phaseId: string,
  ): Promise<MilestonePhaseAssignmentView> {
    if (typeof milestoneId !== 'string' || milestoneId === '') {
      throw new ApiError(400, 'validation_failed', 'milestoneId is required', [
        { field: 'milestoneId', message: 'must be a non-empty string' },
      ]);
    }
    if (typeof phaseId !== 'string' || phaseId === '') {
      throw new ApiError(400, 'validation_failed', 'phaseId is required', [
        { field: 'phaseId', message: 'must be a non-empty string' },
      ]);
    }
    return this.phases.assign(context, principal, milestoneId, phaseId);
  }
}

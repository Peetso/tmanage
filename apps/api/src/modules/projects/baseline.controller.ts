import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { PROJECT_BASELINE_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type {
  ProjectBaselineService,
  ProjectBaselineView,
  ProjectBaselineVarianceView,
} from './baseline.service.js';

/**
 * PROJ / module 8 (x295). A project's **milestone-plan baseline**: snapshot the current plan as a
 * named baseline, list the baselines, and read a variance view (today's dates vs the frozen plan).
 *
 * Nested under `…/projects/:projectId/baselines`, so the project is named in the path and the service
 * resolves it tenant-scoped before it authorizes or writes (Known-trap). Every route is gated on
 * `project.manage`. Like every tenant-scoped controller here, it never reads `organizationId` from
 * the body, a header, or its own `:orgSlug` segment.
 */

interface CreateBaselineBody {
  readonly label?: unknown;
}

/** `project_baselines.label` is `VARCHAR(300)`. */
const MAX_LABEL_LENGTH = 300;

@Controller('v1/organizations/:orgSlug/projects/:projectId/baselines')
export class ProjectBaselineController {
  constructor(
    @Inject(PROJECT_BASELINE_SERVICE) private readonly baselines: ProjectBaselineService,
  ) {}

  @Get()
  @RequireCapability('project.manage')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
    @Query('limit') limit?: string,
  ): Promise<{ readonly baselines: readonly ProjectBaselineView[] }> {
    if (typeof projectId !== 'string' || projectId === '') {
      throw new ApiError(400, 'validation_failed', 'projectId is required', [
        { field: 'projectId', message: 'must be a non-empty string' },
      ]);
    }

    const parsedLimit = limit === undefined ? undefined : Number(limit);
    if (parsedLimit !== undefined && !Number.isSafeInteger(parsedLimit)) {
      throw new ApiError(400, 'validation_failed', 'limit must be an integer', [
        { field: 'limit', message: 'must be an integer' },
      ]);
    }

    return {
      baselines: await this.baselines.list(context, principal, {
        projectId,
        ...(parsedLimit !== undefined ? { limit: parsedLimit } : {}),
      }),
    };
  }

  @Post()
  @RequireCapability('project.manage')
  @HttpCode(201)
  async create(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
    @Body() body: CreateBaselineBody,
  ): Promise<ProjectBaselineView> {
    if (typeof projectId !== 'string' || projectId === '') {
      throw new ApiError(400, 'validation_failed', 'projectId is required', [
        { field: 'projectId', message: 'must be a non-empty string' },
      ]);
    }

    const label = typeof body?.label === 'string' ? body.label.trim() : undefined;
    const details = [
      ...(label ? [] : [{ field: 'label', message: 'must be a non-empty string' }]),
      ...(label && label.length > MAX_LABEL_LENGTH
        ? [{ field: 'label', message: `must be ${MAX_LABEL_LENGTH} characters or fewer` }]
        : []),
    ];
    if (details.length > 0 || !label) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
    }

    return this.baselines.snapshot(context, principal, { projectId, label });
  }

  @Get(':baselineId/variance')
  @RequireCapability('project.manage')
  async variance(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
    @Param('baselineId') baselineId: string,
  ): Promise<ProjectBaselineVarianceView> {
    if (typeof projectId !== 'string' || projectId === '') {
      throw new ApiError(400, 'validation_failed', 'projectId is required', [
        { field: 'projectId', message: 'must be a non-empty string' },
      ]);
    }
    if (typeof baselineId !== 'string' || baselineId === '') {
      throw new ApiError(400, 'validation_failed', 'baselineId is required', [
        { field: 'baselineId', message: 'must be a non-empty string' },
      ]);
    }

    return this.baselines.variance(context, principal, { projectId, baselineId });
  }

  @Delete(':baselineId')
  @RequireCapability('project.manage')
  @HttpCode(204)
  async discard(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
    @Param('baselineId') baselineId: string,
  ): Promise<void> {
    if (typeof projectId !== 'string' || projectId === '') {
      throw new ApiError(400, 'validation_failed', 'projectId is required', [
        { field: 'projectId', message: 'must be a non-empty string' },
      ]);
    }
    if (typeof baselineId !== 'string' || baselineId === '') {
      throw new ApiError(400, 'validation_failed', 'baselineId is required', [
        { field: 'baselineId', message: 'must be a non-empty string' },
      ]);
    }

    await this.baselines.discard(context, principal, { projectId, baselineId });
  }
}

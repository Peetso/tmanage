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
  Query,
} from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { PROJECT_BASELINE_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { Throttle } from '../rate-limits/throttle-policies.js';
import { BASELINE_KINDS } from './baseline.repository.js';
import type { BaselineKind } from './baseline.repository.js';
import type {
  ProjectBaselineOverlayView,
  ProjectBaselineService,
  ProjectBaselineView,
  ProjectBaselineVarianceView,
} from './baseline.service.js';

/**
 * PROJ / module 8 (x295) + 53-05. A project's **baselines**: freeze the plan (milestones, and for
 * `kind: 'full'` every work item's dates), list them, pick the current one, read the working-day
 * variance, and read the current baseline's overlay for the Gantt ghost bars.
 *
 * Capabilities (53-05 maps `schedule.manage` onto the existing ones; no capabilities.ts change):
 * writes — create, set current, delete — need `project.manage`; reads — list, variance, overlay —
 * need `work.read`, and the service adds the project relation, so members read but never write.
 *
 * Nested under `…/projects/:projectId/baselines`; the service resolves the project tenant-scoped
 * before it authorizes or writes (Known-trap). It never reads `organizationId` from the body, a
 * header, or its own `:orgSlug` segment. No portal route lives here: the client-safe timeline is
 * 53-07's, and `label` / `note` never leave these internal routes.
 */

interface CreateBaselineBody {
  readonly label?: unknown;
  readonly note?: unknown;
  readonly kind?: unknown;
}

interface PatchBaselineBody {
  readonly isCurrent?: unknown;
}

/** `project_baselines.label` is `VARCHAR(300)`, `note` `VARCHAR(500)`. */
const MAX_LABEL_LENGTH = 300;
const MAX_NOTE_LENGTH = 500;
/** 53-05: freezing up to 5,000 rows is heavy; ten a minute per caller address is plenty. */
const BASELINE_CREATE_LIMITS = {
  perMinute: 10,
  key: 'ip',
  onStoreError: 'open',
} as const;

function requireId(field: string, value: unknown): string {
  if (typeof value !== 'string' || value === '') {
    throw new ApiError(400, 'validation_failed', `${field} is required`, [
      { field, message: 'must be a non-empty string' },
    ]);
  }
  return value;
}

@Controller('v1/organizations/:orgSlug/projects/:projectId/baselines')
export class ProjectBaselineController {
  constructor(
    @Inject(PROJECT_BASELINE_SERVICE) private readonly baselines: ProjectBaselineService,
  ) {}

  @Get()
  @RequireCapability('work.read')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
    @Query('limit') limit?: string,
  ): Promise<{ readonly baselines: readonly ProjectBaselineView[] }> {
    requireId('projectId', projectId);
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
  @Throttle('baseline_create', BASELINE_CREATE_LIMITS)
  @HttpCode(201)
  async create(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
    @Body() body: CreateBaselineBody,
  ): Promise<ProjectBaselineView> {
    requireId('projectId', projectId);

    const label = typeof body?.label === 'string' ? body.label.trim() : undefined;
    const note =
      body?.note === undefined || body.note === null
        ? null
        : typeof body.note === 'string'
          ? body.note.trim() || null
          : undefined;
    const kind = body?.kind === undefined ? 'full' : body.kind;
    const details = [
      ...(label ? [] : [{ field: 'label', message: 'must be a non-empty string' }]),
      ...(label && label.length > MAX_LABEL_LENGTH
        ? [{ field: 'label', message: `must be ${MAX_LABEL_LENGTH} characters or fewer` }]
        : []),
      ...(note === undefined ? [{ field: 'note', message: 'must be a string or null' }] : []),
      ...(note && note.length > MAX_NOTE_LENGTH
        ? [{ field: 'note', message: `must be ${MAX_NOTE_LENGTH} characters or fewer` }]
        : []),
      ...(BASELINE_KINDS.includes(kind as BaselineKind)
        ? []
        : [{ field: 'kind', message: `must be one of ${BASELINE_KINDS.join(', ')}` }]),
    ];
    if (details.length > 0 || !label || note === undefined) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
    }

    return this.baselines.snapshot(context, principal, {
      projectId,
      label,
      note,
      kind: kind as BaselineKind,
    });
  }

  /** The current baseline's frozen item dates (Gantt ghost bars). Declared before `:baselineId`. */
  @Get('current/overlay')
  @RequireCapability('work.read')
  async overlay(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
  ): Promise<ProjectBaselineOverlayView> {
    requireId('projectId', projectId);
    return this.baselines.overlay(context, principal, projectId);
  }

  @Get(':baselineId/variance')
  @RequireCapability('work.read')
  async variance(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
    @Param('baselineId') baselineId: string,
    @Query('against') against?: string,
    @Query('cursor') cursor?: string,
  ): Promise<ProjectBaselineVarianceView> {
    requireId('projectId', projectId);
    requireId('baselineId', baselineId);
    if (against !== undefined) requireId('against', against);
    if (cursor !== undefined) requireId('cursor', cursor);

    return this.baselines.variance(context, principal, {
      projectId,
      baselineId,
      ...(against !== undefined ? { against } : {}),
      ...(cursor !== undefined ? { cursor } : {}),
    });
  }

  /** `{isCurrent: true}` makes this the project's one current baseline. */
  @Patch(':baselineId')
  @RequireCapability('project.manage')
  async patch(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
    @Param('baselineId') baselineId: string,
    @Body() body: PatchBaselineBody,
  ): Promise<ProjectBaselineView> {
    requireId('projectId', projectId);
    requireId('baselineId', baselineId);
    if (body?.isCurrent !== true) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: 'isCurrent', message: 'must be true' },
      ]);
    }
    return this.baselines.activate(context, principal, { projectId, baselineId });
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
    requireId('projectId', projectId);
    requireId('baselineId', baselineId);
    await this.baselines.discard(context, principal, { projectId, baselineId });
  }
}

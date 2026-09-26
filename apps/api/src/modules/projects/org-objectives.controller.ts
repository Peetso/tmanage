import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { ORG_OBJECTIVES_SERVICE } from '../../common/http/tokens.js';
import { ORG_OBJECTIVE_STATUSES } from '../../common/database/schema.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { OrgObjectiveView, OrgObjectivesService } from './org-objectives.service.js';
import type { OrgObjectiveStatus } from './org-objectives.repository.js';

/**
 * PROJ / module 8 (x136). An organization's objectives / OKRs: create, list, and transition through
 * the lifecycle — the org-level counterpart of `ProjectObjectivesController` (x124).
 *
 * Mounted at `…/organizations/:orgSlug/objectives`, org-scoped (no `:projectId` segment). Gated on
 * `project.manage` for the writes and `work.read` for the list. Like every tenant-scoped controller
 * here, it never reads `organizationId` from the body, a header, or its own `:orgSlug` segment: it
 * receives the `TenantContext` that `TenantContextGuard` built from a membership row and passes it on.
 */

interface CreateObjectiveBody {
  readonly name?: unknown;
  readonly description?: unknown;
  readonly target?: unknown;
  readonly status?: unknown;
}

interface PatchObjectiveBody {
  readonly status?: unknown;
}

/** `org_objectives.name` / `target` are `VARCHAR(300)`. */
const MAX_NAME_LENGTH = 300;
const MAX_TARGET_LENGTH = 300;
/** `org_objectives.description` is `TEXT`; this is a form field, not a document. */
const MAX_DESCRIPTION_LENGTH = 20_000;

/** The only statuses a transition may set: an objective closes to met or missed, never reopens. */
const TRANSITION_TARGETS: readonly OrgObjectiveStatus[] = ['met', 'missed'];

function isObjectiveStatus(value: unknown): value is OrgObjectiveStatus {
  return typeof value === 'string' && (ORG_OBJECTIVE_STATUSES as readonly string[]).includes(value);
}

@Controller('v1/organizations/:orgSlug/objectives')
export class OrgObjectivesController {
  constructor(@Inject(ORG_OBJECTIVES_SERVICE) private readonly objectives: OrgObjectivesService) {}

  @Get()
  @RequireCapability('work.read')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Query('limit') limit?: string,
  ): Promise<{ readonly objectives: readonly OrgObjectiveView[] }> {
    const parsedLimit = limit === undefined ? undefined : Number(limit);
    if (parsedLimit !== undefined && !Number.isSafeInteger(parsedLimit)) {
      throw new ApiError(400, 'validation_failed', 'limit must be an integer', [
        { field: 'limit', message: 'must be an integer' },
      ]);
    }

    return {
      objectives: await this.objectives.list(context, principal, {
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
    @Body() body: CreateObjectiveBody,
  ): Promise<OrgObjectiveView> {
    const name = typeof body?.name === 'string' ? body.name.trim() : undefined;
    const description =
      typeof body?.description === 'string' && body.description.trim() !== ''
        ? body.description.trim()
        : undefined;
    const target =
      typeof body?.target === 'string' && body.target.trim() !== '' ? body.target.trim() : undefined;

    const details = [
      ...(name ? [] : [{ field: 'name', message: 'must be a non-empty string' }]),
      ...(name && name.length > MAX_NAME_LENGTH
        ? [{ field: 'name', message: `must be ${MAX_NAME_LENGTH} characters or fewer` }]
        : []),
      ...(description && description.length > MAX_DESCRIPTION_LENGTH
        ? [
            {
              field: 'description',
              message: `must be ${MAX_DESCRIPTION_LENGTH} characters or fewer`,
            },
          ]
        : []),
      ...(target && target.length > MAX_TARGET_LENGTH
        ? [{ field: 'target', message: `must be ${MAX_TARGET_LENGTH} characters or fewer` }]
        : []),
      ...(body?.status !== undefined && !isObjectiveStatus(body.status)
        ? [{ field: 'status', message: `must be one of ${ORG_OBJECTIVE_STATUSES.join(', ')}` }]
        : []),
    ];

    if (details.length > 0) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
    }
    // Narrowed by the `details.length` check above, which TypeScript cannot see through.
    if (!name) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
    }

    const status: OrgObjectiveStatus = isObjectiveStatus(body?.status) ? body.status : 'open';

    return this.objectives.create(context, principal, {
      name,
      ...(description === undefined ? {} : { description }),
      ...(target === undefined ? {} : { target }),
      status,
    });
  }

  /**
   * Transition an objective through its lifecycle. The body's `status` must be `met` or `missed` — an
   * objective is never reopened — so any other value is a 422. The guarded state machine (a transition
   * is legal only from `open`; an illegal one is a 409 with no write) lives in the service, as does the
   * tenant resolution and the not-found for an unknown/cross-tenant `objectiveId`.
   */
  @Patch(':objectiveId')
  @RequireCapability('project.manage')
  async patch(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('objectiveId') objectiveId: string,
    @Body() body: PatchObjectiveBody,
  ): Promise<OrgObjectiveView> {
    if (typeof objectiveId !== 'string' || objectiveId === '') {
      throw new ApiError(400, 'validation_failed', 'objectiveId is required', [
        { field: 'objectiveId', message: 'must be a non-empty string' },
      ]);
    }
    if (
      !isObjectiveStatus(body?.status) ||
      !TRANSITION_TARGETS.includes(body.status as OrgObjectiveStatus)
    ) {
      throw new ApiError(422, 'validation_failed', 'An objective can only be met or missed', [
        { field: 'status', message: `must be one of ${TRANSITION_TARGETS.join(', ')}` },
      ]);
    }
    return this.objectives.transition(context, principal, objectiveId, body.status);
  }
}

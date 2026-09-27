import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { KEY_RESULTS_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { KeyResultView, KeyResultsService } from './key-results.service.js';
import type { UpdateKeyResultInput } from './key-results.repository.js';

/**
 * PROJ / module 8 (x207). An objective's key results: create, list, and inline-edit the measurable
 * children of a project objective.
 *
 * Nested under `…/objectives/:objectiveId/key-results`, so the objective is named in the path and the
 * service resolves it tenant-scoped (and its project, for the relation gate) before it authorizes or
 * writes (Known-trap). Gated on `project.manage` for the writes and `work.read` for the list. Like every
 * tenant-scoped controller here, it never reads `organizationId` from the body, a header, or its own
 * `:orgSlug` segment: it receives the `TenantContext` `TenantContextGuard` built and passes it on.
 */

interface CreateKeyResultBody {
  readonly title?: unknown;
  readonly targetValue?: unknown;
  readonly currentValue?: unknown;
  readonly unit?: unknown;
}

interface PatchKeyResultBody {
  readonly title?: unknown;
  readonly targetValue?: unknown;
  readonly currentValue?: unknown;
  readonly unit?: unknown;
}

/** `objective_key_results.title` is `VARCHAR(300)`, `unit` is `VARCHAR(64)`. */
const MAX_TITLE_LENGTH = 300;
const MAX_UNIT_LENGTH = 64;

/** A value column is a non-negative safe integer — the meaning is the application's, not the engine's. */
function isValidValue(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

@Controller('v1/organizations/:orgSlug/objectives/:objectiveId/key-results')
export class KeyResultsController {
  constructor(@Inject(KEY_RESULTS_SERVICE) private readonly keyResults: KeyResultsService) {}

  @Get()
  @RequireCapability('work.read')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('objectiveId') objectiveId: string,
    @Query('limit') limit?: string,
  ): Promise<{ readonly keyResults: readonly KeyResultView[] }> {
    if (typeof objectiveId !== 'string' || objectiveId === '') {
      throw new ApiError(400, 'validation_failed', 'objectiveId is required', [
        { field: 'objectiveId', message: 'must be a non-empty string' },
      ]);
    }

    const parsedLimit = limit === undefined ? undefined : Number(limit);
    if (parsedLimit !== undefined && !Number.isSafeInteger(parsedLimit)) {
      throw new ApiError(400, 'validation_failed', 'limit must be an integer', [
        { field: 'limit', message: 'must be an integer' },
      ]);
    }

    return {
      keyResults: await this.keyResults.list(context, principal, {
        objectiveId,
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
    @Param('objectiveId') objectiveId: string,
    @Body() body: CreateKeyResultBody,
  ): Promise<KeyResultView> {
    if (typeof objectiveId !== 'string' || objectiveId === '') {
      throw new ApiError(400, 'validation_failed', 'objectiveId is required', [
        { field: 'objectiveId', message: 'must be a non-empty string' },
      ]);
    }

    const title = typeof body?.title === 'string' ? body.title.trim() : undefined;
    const unit = typeof body?.unit === 'string' ? body.unit.trim() : undefined;
    // `currentValue` is optional at creation and defaults to 0.
    const currentValue = body?.currentValue === undefined ? 0 : body.currentValue;

    const details = [
      ...(title ? [] : [{ field: 'title', message: 'must be a non-empty string' }]),
      ...(title && title.length > MAX_TITLE_LENGTH
        ? [{ field: 'title', message: `must be ${MAX_TITLE_LENGTH} characters or fewer` }]
        : []),
      ...(unit ? [] : [{ field: 'unit', message: 'must be a non-empty string' }]),
      ...(unit && unit.length > MAX_UNIT_LENGTH
        ? [{ field: 'unit', message: `must be ${MAX_UNIT_LENGTH} characters or fewer` }]
        : []),
      ...(isValidValue(body?.targetValue)
        ? []
        : [{ field: 'targetValue', message: 'must be a non-negative integer' }]),
      ...(isValidValue(currentValue)
        ? []
        : [{ field: 'currentValue', message: 'must be a non-negative integer' }]),
    ];

    if (details.length > 0) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
    }
    // Narrowed by the `details.length` check above, which TypeScript cannot see through.
    if (!title || !unit || !isValidValue(body.targetValue) || !isValidValue(currentValue)) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
    }

    return this.keyResults.create(context, principal, {
      objectiveId,
      title,
      targetValue: body.targetValue,
      currentValue,
      unit,
    });
  }

  /**
   * Inline-edit a key result's body — its title, target, current value, or unit. At least one field
   * must be present; the tenant/objective resolution and the not-found for an unknown/cross-tenant or
   * mis-parented `keyResultId` live in the service.
   */
  @Patch(':keyResultId')
  @RequireCapability('project.manage')
  async patch(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('objectiveId') objectiveId: string,
    @Param('keyResultId') keyResultId: string,
    @Body() body: PatchKeyResultBody,
  ): Promise<KeyResultView> {
    if (typeof objectiveId !== 'string' || objectiveId === '') {
      throw new ApiError(400, 'validation_failed', 'objectiveId is required', [
        { field: 'objectiveId', message: 'must be a non-empty string' },
      ]);
    }
    if (typeof keyResultId !== 'string' || keyResultId === '') {
      throw new ApiError(400, 'validation_failed', 'keyResultId is required', [
        { field: 'keyResultId', message: 'must be a non-empty string' },
      ]);
    }

    const title = typeof body?.title === 'string' ? body.title.trim() : undefined;
    const unit = typeof body?.unit === 'string' ? body.unit.trim() : undefined;

    const details = [
      ...(body?.title !== undefined && (!title || title.length > MAX_TITLE_LENGTH)
        ? [
            {
              field: 'title',
              message: `must be a non-empty string of ${MAX_TITLE_LENGTH} or fewer`,
            },
          ]
        : []),
      ...(body?.unit !== undefined && (!unit || unit.length > MAX_UNIT_LENGTH)
        ? [{ field: 'unit', message: `must be a non-empty string of ${MAX_UNIT_LENGTH} or fewer` }]
        : []),
      ...(body?.targetValue !== undefined && !isValidValue(body.targetValue)
        ? [{ field: 'targetValue', message: 'must be a non-negative integer' }]
        : []),
      ...(body?.currentValue !== undefined && !isValidValue(body.currentValue)
        ? [{ field: 'currentValue', message: 'must be a non-negative integer' }]
        : []),
    ];
    if (details.length > 0) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
    }

    const update: UpdateKeyResultInput = {
      ...(title === undefined ? {} : { title }),
      ...(unit === undefined ? {} : { unit }),
      ...(body?.targetValue === undefined ? {} : { targetValue: body.targetValue as number }),
      ...(body?.currentValue === undefined ? {} : { currentValue: body.currentValue as number }),
    };

    if (Object.keys(update).length === 0) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: 'body', message: 'at least one of title, targetValue, currentValue, unit' },
      ]);
    }

    return this.keyResults.update(context, principal, objectiveId, keyResultId, update);
  }
}

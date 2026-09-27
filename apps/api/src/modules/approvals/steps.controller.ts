import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import {
  APPROVAL_STEPS_SERVICE,
  type ApprovalChainView,
  type ApprovalStepsService,
  type DefineStepInput,
} from './steps.service.js';

/**
 * Sequential approval steps (x315, Requests, decisions & approvals; module §Requests). Three
 * endpoints under one approval: define the ordered chain, decide a step (advance the chain), and
 * read the chain with its active step.
 *
 * ## The capability
 *
 * Defining and deciding are gated on `approval.decide`; reading on `approval.read`. `@RequireCapability`
 * is the **coarse** UX ceiling (`25-AUTH-AND-TENANT-ISOLATION` §3) — it admits the roles that could
 * plausibly touch an approval and answers nothing about *this* one. The real decision is the service's
 * `authorize()` with the approval loaded (403), exactly as the sibling approvals surface defers to the
 * object layer.
 *
 * ## The Known-trap order — resolve BEFORE authorize
 *
 * The approval id and step id are path parameters; the service resolves each **within the acting
 * tenant before any authorization or write**, so a cross-tenant or unknown id is a 404 with nothing
 * written — never a 403 that would reveal another tenant's approval. This controller validates the
 * request body shape only (a 400 with nothing written): the chain rules (active step, already-decided)
 * are the service's, and are 409s.
 *
 * There is no web wiring this slice; `ApprovalStepsView` is authored ready for it.
 */

/** A non-negative step index is small — a chain does not have thousands of steps. */
const MAX_POSITION = 1000;
/** `approval_steps.approver_role` is `VARCHAR(64)`. */
const MAX_ROLE_LENGTH = 64;

interface DefineStepsBody {
  readonly steps?: unknown;
}

interface RawStep {
  readonly position?: unknown;
  readonly approverRole?: unknown;
  readonly approverUserId?: unknown;
}

interface DecideStepBody {
  readonly decision?: unknown;
}

function validateSteps(raw: unknown): readonly DefineStepInput[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field: 'steps', message: 'must be a non-empty array of steps' },
    ]);
  }

  const seen = new Set<number>();
  const steps = raw.map((entry, index): DefineStepInput => {
    const step = (entry ?? {}) as RawStep;
    const position = step.position;
    if (
      typeof position !== 'number' ||
      !Number.isSafeInteger(position) ||
      position < 0 ||
      position > MAX_POSITION
    ) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        {
          field: `steps.${index}.position`,
          message: `must be an integer between 0 and ${MAX_POSITION}`,
        },
      ]);
    }
    if (seen.has(position)) {
      throw new ApiError(
        400,
        'validation_failed',
        'The request body is invalid',
        [{ field: `steps.${index}.position`, message: 'positions must be unique' }],
        'approval_step_duplicate_position',
      );
    }
    seen.add(position);

    const approverRole = typeof step.approverRole === 'string' ? step.approverRole.trim() : '';
    if (approverRole === '') {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: `steps.${index}.approverRole`, message: 'must be a non-empty string' },
      ]);
    }
    if (approverRole.length > MAX_ROLE_LENGTH) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        {
          field: `steps.${index}.approverRole`,
          message: `must be ${MAX_ROLE_LENGTH} characters or fewer`,
        },
      ]);
    }

    let approverUserId: string | null = null;
    if (step.approverUserId !== undefined && step.approverUserId !== null) {
      if (typeof step.approverUserId !== 'string' || step.approverUserId.trim() === '') {
        throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
          { field: `steps.${index}.approverUserId`, message: 'must be a string or null' },
        ]);
      }
      approverUserId = step.approverUserId;
    }

    return { position, approverRole, approverUserId };
  });

  return steps;
}

@Controller('v1/organizations/:orgSlug/approvals/:approvalId/steps')
export class ApprovalStepsController {
  constructor(@Inject(APPROVAL_STEPS_SERVICE) private readonly steps: ApprovalStepsService) {}

  /**
   * Define the chain. `approval.decide`, resolve-before-authorize: a cross-tenant/unknown approval id
   * is a 404 with no write; a caller without `approval.decide` (or outside the project) is a 403; an
   * empty or duplicate-position body is a 400 with nothing written.
   */
  @Post()
  @HttpCode(201)
  @RequireCapability('approval.decide')
  async define(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('approvalId') approvalId: string,
    @Body() body: DefineStepsBody,
  ): Promise<ApprovalChainView> {
    const steps = validateSteps(body?.steps);
    return this.steps.define(context, principal, approvalId, steps);
  }

  /**
   * Read the chain with its active step. `approval.read`, resolve-before-authorize: a cross-tenant or
   * unknown approval id is a 404; a caller without `approval.read` is a 403.
   */
  @Get()
  @RequireCapability('approval.read')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('approvalId') approvalId: string,
  ): Promise<ApprovalChainView> {
    return this.steps.list(context, principal, approvalId);
  }

  /**
   * Decide a step — advance the chain. `approval.decide`, resolve-before-authorize: a cross-tenant or
   * unknown approval/step id is a 404 with no write; a caller without `approval.decide` is a 403; a
   * non-active or already-decided step is a 409 with no write.
   */
  @Put(':stepId')
  @HttpCode(200)
  @RequireCapability('approval.decide')
  async decide(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('approvalId') approvalId: string,
    @Param('stepId') stepId: string,
    @Body() body: DecideStepBody,
  ): Promise<ApprovalChainView> {
    if (body?.decision !== 'approve' && body?.decision !== 'reject') {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: 'decision', message: 'must be approve or reject' },
      ]);
    }
    return this.steps.decide(context, principal, approvalId, stepId, body.decision);
  }
}

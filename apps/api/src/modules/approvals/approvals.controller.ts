import { Body, Controller, HttpCode, Inject, Param, Post } from '@nestjs/common';
import type { ApprovalPolicy, Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { APPROVALS_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { ApprovalDecisionView, ApprovalsService } from './approvals.service.js';

/**
 * FR-05's surface — open a review request, and decide one.
 *
 * `@RequireCapability('approval.read')` on both routes is the **coarse** ceiling, UX only
 * (`25-AUTH-AND-TENANT-ISOLATION` §3): it admits the roles that could plausibly touch an approval
 * and answers nothing about *this* one. The real decisions are the service's `authorize()` calls
 * with the row loaded — `deliverable.review` (internal) to open, and `approval.decide` against the
 * reviewer relation to decide (AUTH-08). This mirrors `ConversationsController.moderateMessage`,
 * which guards the object-layer `conversation.moderate` with the coarse `conversation.read`; it is
 * why `approval.decide` stays out of `GUARDED_OPERATIONS`.
 *
 * There is no web client this slice (x92-b adds the client deep-link screen and projection; x92-c
 * the E2E-05 journey). These endpoints are authored ready for it.
 */

const POLICIES: readonly ApprovalPolicy[] = ['all_required', 'any_one', 'ordered_sequence'];

interface OpenApprovalBody {
  readonly deliverableVersionId?: unknown;
  readonly reviewerIds?: unknown;
  readonly policy?: unknown;
}

interface DecisionBody {
  readonly decision?: unknown;
  readonly version?: unknown;
  readonly feedback?: unknown;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field, message: 'must be a non-empty string' },
    ]);
  }
  return value;
}

@Controller('v1/organizations/:orgSlug/approvals')
export class ApprovalsController {
  constructor(@Inject(APPROVALS_SERVICE) private readonly approvals: ApprovalsService) {}

  @Post()
  @HttpCode(201)
  @RequireCapability('approval.read')
  async open(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: OpenApprovalBody,
  ): Promise<ApprovalDecisionView> {
    const deliverableVersionId = requireString(body.deliverableVersionId, 'deliverableVersionId');

    if (!Array.isArray(body.reviewerIds) || body.reviewerIds.some((id) => typeof id !== 'string')) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: 'reviewerIds', message: 'must be an array of user ids' },
      ]);
    }

    if (body.policy !== undefined && !POLICIES.includes(body.policy as ApprovalPolicy)) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: 'policy', message: `must be one of ${POLICIES.join(', ')}` },
      ]);
    }

    return this.approvals.open(context, principal, {
      deliverableVersionId,
      reviewerIds: body.reviewerIds as string[],
      ...(body.policy ? { policy: body.policy as ApprovalPolicy } : {}),
    });
  }

  @Post(':approvalId/decision')
  @HttpCode(200)
  @RequireCapability('approval.read')
  async decide(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('approvalId') approvalId: string,
    @Body() body: DecisionBody,
  ): Promise<ApprovalDecisionView> {
    if (body.decision !== 'approve' && body.decision !== 'request_changes') {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: 'decision', message: 'must be approve or request_changes' },
      ]);
    }

    if (
      typeof body.version !== 'number' ||
      !Number.isSafeInteger(body.version) ||
      body.version < 1
    ) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: 'version', message: 'must be a positive integer' },
      ]);
    }

    if (body.feedback !== undefined && typeof body.feedback !== 'string') {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: 'feedback', message: 'must be a string' },
      ]);
    }

    return this.approvals.decide(context, principal, approvalId, {
      decision: body.decision,
      expectedVersion: body.version,
      ...(typeof body.feedback === 'string' ? { feedback: body.feedback } : {}),
    });
  }
}

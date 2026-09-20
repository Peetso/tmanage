import { Body, Controller, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import type { ApprovalPolicy, Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { APPROVALS_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { ClientProjectionPayload } from '../../common/database/schema.js';
import type {
  ApprovalDecisionView,
  ApprovalsService,
  ClientDecideView,
  ClientProjectionView,
} from './approvals.service.js';

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

interface ClientDecisionBody {
  readonly decision?: unknown;
  readonly feedback?: unknown;
}

interface PublishBody {
  readonly deliverableVersionId?: unknown;
  readonly projection?: unknown;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field, message: 'must be a non-empty string' },
    ]);
  }
  return value;
}

/** A field that is a string, explicit null, or omitted — normalised to `string | null`. */
function optionalStringOrNull(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field, message: 'must be a string or null' },
    ]);
  }
  return value;
}

/**
 * Build the client-safe payload from an allowlist — 12-PERMISSION-MATRIX §1 and nothing else.
 *
 * The payload is assembled field by field from the known allowlisted keys, so a caller cannot
 * smuggle a forbidden internal field (cost, estimates, staff review, private threads, risk
 * rationale, security metadata, other-client data — 25 §7) into the stored projection: anything
 * not named here is dropped, never persisted. This is why the store is not
 * `serializeInternalObject(); delete fields`, which 25 §7 forbids by name.
 */
function requireProjectionPayload(value: unknown): ClientProjectionPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field: 'projection', message: 'must be an object' },
    ]);
  }
  const raw = value as Record<string, unknown>;

  let approvedContacts: readonly string[] = [];
  if (raw['approvedContacts'] !== undefined) {
    if (
      !Array.isArray(raw['approvedContacts']) ||
      raw['approvedContacts'].some((entry) => typeof entry !== 'string')
    ) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: 'projection.approvedContacts', message: 'must be an array of strings' },
      ]);
    }
    approvedContacts = raw['approvedContacts'] as string[];
  }

  return {
    title: requireString(raw['title'], 'projection.title'),
    summary: optionalStringOrNull(raw['summary'], 'projection.summary'),
    milestoneState: optionalStringOrNull(raw['milestoneState'], 'projection.milestoneState'),
    forecastDate: optionalStringOrNull(raw['forecastDate'], 'projection.forecastDate'),
    publishedRisk: optionalStringOrNull(raw['publishedRisk'], 'projection.publishedRisk'),
    decision: optionalStringOrNull(raw['decision'], 'projection.decision'),
    approvedContacts: [...approvedContacts],
  };
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

  /**
   * Publish a governed version to the client — freeze its immutable client-safe projection.
   *
   * `@RequireCapability('deliverable.publish')` is the coarse UX ceiling (25 §3): it admits the
   * internal roles that may publish and is meaningless to a client, whose ceiling never holds this
   * internal-only capability. The real decision — the project relation and the internal-only guard
   * — is the service's `authorize()` with the version loaded, exactly as `decide` defers to the
   * reviewer relation.
   */
  @Post('projections')
  @HttpCode(201)
  @RequireCapability('deliverable.publish')
  async publish(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: PublishBody,
  ): Promise<ClientProjectionView> {
    const deliverableVersionId = requireString(body.deliverableVersionId, 'deliverableVersionId');
    const projection = requireProjectionPayload(body.projection);

    return this.approvals.publish(context, principal, { deliverableVersionId, projection });
  }

  /**
   * Read the immutable client projection for a governed version.
   *
   * `@RequireCapability('client_projection.read')` is the coarse ceiling — the one read every
   * client role holds (capabilities.ts) — and the service's `authorize()` against the client
   * relation is the real gate. A caller outside the relation, or in another tenant, gets the same
   * 404 as a version that was never published.
   */
  @Get('projections/:deliverableVersionId')
  @HttpCode(200)
  @RequireCapability('client_projection.read')
  async readProjection(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('deliverableVersionId') deliverableVersionId: string,
  ): Promise<ClientProjectionView> {
    return this.approvals.readProjection(context, principal, deliverableVersionId);
  }

  /**
   * Decide from the client deep link — approve or request changes on a published version.
   *
   * Version-addressed, matching the projection read above: the client names the
   * `deliverableVersionId` it is looking at, not an internal approval id. `@RequireCapability`
   * `('approval.read')` is the coarse UX ceiling every client decider role holds, exactly as the
   * reviewer decide route uses it; the real gate is the service's `authorize()` on `approval.decide`
   * against the client's project relation and the projection's approved-contacts allowlist. The
   * response is the client-safe {@link ClientDecideView}, never the internal decision record.
   */
  @Post('projections/:deliverableVersionId/decision')
  @HttpCode(200)
  @RequireCapability('approval.read')
  async clientDecide(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('deliverableVersionId') deliverableVersionId: string,
    @Body() body: ClientDecisionBody,
  ): Promise<ClientDecideView> {
    if (body.decision !== 'approve' && body.decision !== 'request_changes') {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: 'decision', message: 'must be approve or request_changes' },
      ]);
    }

    if (body.feedback !== undefined && typeof body.feedback !== 'string') {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: 'feedback', message: 'must be a string' },
      ]);
    }

    return this.approvals.clientDecide(context, principal, deliverableVersionId, {
      decision: body.decision,
      ...(typeof body.feedback === 'string' ? { feedback: body.feedback } : {}),
    });
  }
}

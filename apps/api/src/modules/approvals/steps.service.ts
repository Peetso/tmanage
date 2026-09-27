import { authorize } from '@tmanage/domain';
import type { Capability, Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { ApprovalStepRow, ApprovalStepState } from '../../common/database/schema.js';
import type { ApprovalsRepository } from './approvals.repository.js';
import type { ApprovalStepsRepository, DefineApprovalStepInput } from './steps.repository.js';

/** The token the module provides this service under. Kept here so `tokens.ts` needs no edit. */
export const APPROVAL_STEPS_SERVICE = Symbol.for('tmanage.ApprovalStepsService');

/** What a caller is allowed to see of one step. `organizationId` is deliberately absent. */
export interface ApprovalStepView {
  readonly id: string;
  readonly approvalId: string;
  readonly position: number;
  readonly approverRole: string;
  readonly approverUserId: string | null;
  readonly state: ApprovalStepState;
  readonly decidedBy: string | null;
  /** An ISO-8601 instant, or null while pending. */
  readonly decidedAt: string | null;
}

/**
 * The chain as read: the steps in position order, plus the id of the *active* step — the lowest
 * position still `pending` — so the screen can highlight it and offer approve/reject on it alone.
 * `activeStepId` is null when every step has been decided.
 */
export interface ApprovalChainView {
  readonly steps: readonly ApprovalStepView[];
  readonly activeStepId: string | null;
}

/** A validated step to define — the controller has already shape-checked and de-duplicated these. */
export interface DefineStepInput {
  readonly position: number;
  readonly approverRole: string;
  readonly approverUserId: string | null;
}

/** An explicit projection, not a serialised row: a column added later is invisible until named. */
function toView(row: ApprovalStepRow): ApprovalStepView {
  return {
    id: row.id,
    approvalId: row.approvalId,
    position: row.position,
    approverRole: row.approverRole,
    approverUserId: row.approverUserId,
    state: row.state as ApprovalStepState,
    decidedBy: row.decidedBy,
    decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
  };
}

/** The active step of a chain — the lowest position still pending, or null when all are decided. */
function activeStep(rows: readonly ApprovalStepRow[]): ApprovalStepRow | null {
  return (
    [...rows].filter((row) => row.state === 'pending').sort((a, b) => a.position - b.position)[0] ??
    null
  );
}

function toChainView(rows: readonly ApprovalStepRow[]): ApprovalChainView {
  const ordered = [...rows].sort((a, b) => a.position - b.position);
  return { steps: ordered.map(toView), activeStepId: activeStep(ordered)?.id ?? null };
}

/**
 * Sequential approval steps — x315's application service (Requests, decisions & approvals; module
 * §Requests). Defines an ordered chain over an approval, advances it one step decision at a time,
 * and reads it with the active step.
 *
 * ## The Known-trap order — resolve BEFORE authorize
 *
 * Both the approval id and the step id are path parameters, so each is **resolved within the acting
 * tenant before any authorization or write** (`ApprovalsRepository`/`ApprovalStepsRepository` are
 * tenant-scoped). An id belonging to another studio (or one that does not exist) resolves to `null`
 * and the request is a 404 with nothing written — the existence of another tenant's approval is
 * never revealed as a 403. Only once a resource in *this* tenant is in hand does the capability
 * decision run.
 *
 * ## The capability gate
 *
 * Defining and deciding steps is gated on `approval.decide`; reading on `approval.read`. The route
 * guard asks the coarse ceiling question; this service adds the authoritative `authorize()` a
 * suspended membership or a non-member of the approval's project fails (403). Managing the chain is
 * distinct from the single-decision reviewer relation (which gates `approvals.service.decide`), so
 * the chain gate is the capability plus tenant/project scope — `isAssignedReviewer` is not the
 * relation asked here.
 */
export class ApprovalStepsService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly approvals: ApprovalsRepository,
    private readonly steps: ApprovalStepsRepository,
  ) {}

  /**
   * Define the chain. Resolve the approval (cross-tenant/unknown → 404, no write), authorize
   * `approval.decide` (deny → 403, no write), then insert the validated steps in one transaction.
   */
  async define(
    context: TenantContext,
    principal: Principal,
    approvalId: string,
    steps: readonly DefineStepInput[],
  ): Promise<ApprovalChainView> {
    const rows = await this.database.transaction(context, async (tx) => {
      const approval = await this.approvals.findById(tx, context, approvalId);
      if (!approval) {
        throw new ApiError(
          404,
          'not_found',
          MESSAGES.notFound,
          undefined,
          'approval_step_approval_not_found',
        );
      }

      this.assertMayManageChain(principal, context, approval.projectId, 'approval.decide');

      const inputs: DefineApprovalStepInput[] = steps.map((step) => ({
        position: step.position,
        approverRole: step.approverRole,
        approverUserId: step.approverUserId,
      }));
      return this.steps.define(tx, context, approval.id, inputs);
    });
    return toChainView(rows);
  }

  /**
   * Read the chain with its active step. Resolve the approval (cross-tenant/unknown → 404), authorize
   * `approval.read` (deny → 403), then list the steps in position order.
   */
  async list(
    context: TenantContext,
    principal: Principal,
    approvalId: string,
  ): Promise<ApprovalChainView> {
    const rows = await this.database.read(context, async (runner) => {
      const approval = await this.approvals.findById(runner, context, approvalId);
      if (!approval) {
        throw new ApiError(
          404,
          'not_found',
          MESSAGES.notFound,
          undefined,
          'approval_step_approval_not_found',
        );
      }

      this.assertMayManageChain(principal, context, approval.projectId, 'approval.read');

      return this.steps.listForApproval(runner, context, approval.id);
    });
    return toChainView(rows);
  }

  /**
   * Record a step's decision — advance the chain. Resolve the approval and the step
   * (cross-tenant/unknown → 404, no write), authorize `approval.decide` (deny → 403, no write), then
   * enforce the ordering: deciding a non-active step, or one already decided, is a 409 with no write.
   */
  async decide(
    context: TenantContext,
    principal: Principal,
    approvalId: string,
    stepId: string,
    decision: 'approve' | 'reject',
  ): Promise<ApprovalChainView> {
    const rows = await this.database.transaction(context, async (tx) => {
      const approval = await this.approvals.findById(tx, context, approvalId);
      if (!approval) {
        throw new ApiError(
          404,
          'not_found',
          MESSAGES.notFound,
          undefined,
          'approval_step_approval_not_found',
        );
      }

      this.assertMayManageChain(principal, context, approval.projectId, 'approval.decide');

      const all = await this.steps.listForApproval(tx, context, approval.id);
      const step = all.find((row) => row.id === stepId && row.approvalId === approval.id) ?? null;
      if (!step) {
        throw new ApiError(
          404,
          'not_found',
          MESSAGES.notFound,
          undefined,
          'approval_step_not_found',
        );
      }

      // Append-only advance: a step that has already been decided cannot be decided again.
      if (step.state !== 'pending') {
        throw new ApiError(
          409,
          'conflict',
          'This approval step has already been decided',
          undefined,
          'approval_step_already_decided',
        );
      }

      // Only the active step — the lowest position still pending — may be decided. Deciding out of
      // order is refused with nothing written.
      const active = activeStep(all);
      if (!active || active.id !== step.id) {
        throw new ApiError(
          409,
          'conflict',
          'This approval step is not the active step in the chain',
          undefined,
          'approval_step_out_of_order',
        );
      }

      const state: ApprovalStepState = decision === 'approve' ? 'approved' : 'rejected';
      await this.steps.decide(tx, context, step.id, { state, decidedBy: context.userId });
      return this.steps.listForApproval(tx, context, approval.id);
    });
    return toChainView(rows);
  }

  /**
   * The capability + tenant/project decision the route guard cannot make (membership status, project
   * relation). A denial is a 403 — the caller is inside the tenant (the resource resolved) but may
   * not manage this chain.
   */
  private assertMayManageChain(
    principal: Principal,
    context: TenantContext,
    projectId: string,
    capability: Capability,
  ): void {
    const verdict = authorize({
      principal,
      capability,
      resource: {
        organizationId: context.organizationId,
        projectId,
        audience: 'internal',
        lifecycle: 'active',
        // Chain management is gated by the capability and tenant/project scope, not by the
        // single-approval reviewer relation (which `approvals.service.decide` enforces). Satisfy the
        // reviewer sub-check so it does not double as a second, unintended gate here.
        isAssignedReviewer: true,
      },
    });
    if (!verdict.allowed) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, verdict.code);
    }
  }
}

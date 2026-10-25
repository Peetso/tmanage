import { approvalStateMachine, hasCapability, isClientRole, isInternalRole } from '@tmanage/domain';
import type { ApprovalState } from '@tmanage/domain';
import { ApiError } from '../../common/http/errors.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';
import type { ApprovalRow } from '../../common/database/schema.js';
import type { DeliverableVersionsRepository } from './deliverable-versions.repository.js';

/**
 * Wave 9 S5 (audit run 1, F16 + F17) — the one precondition check every route that opens an
 * approval runs: the governed "send for approval" (`DeliverablesService.send`) and the staff review
 * request (`ApprovalsService.open`).
 *
 * Before this, `open` skipped every rule `send` applied, so a project member could open a second
 * approval on a version the client had already approved (re-opening it) or on one already waiting
 * for the client (shadowing the client's approval with a self-approved one). The readers take the
 * newest approval per version, so either move rewrote the deliverable's state. Now both routes
 * refuse the same way:
 *
 * - only the deliverable's newest version may be sent (409 `version_superseded`);
 * - no approval on it may still be waiting (409 `approval_pending`) or already decided
 *   (409 `approval_terminal`: a decided version is final, "upload the next version");
 * - the requester may not name themselves as a reviewer (422).
 *
 * Because nothing can be opened while a live or decided approval exists, a version carries at most
 * one such approval, and the version-addressed readers (the client decide route, the deliverable
 * state) always bind to the approval `send` created.
 */

/** The approval lookups this check needs; `ApprovalsRepository` satisfies it. */
export interface ApprovalsByVersion {
  listByVersion(
    runner: TenantQueryRunner,
    context: TenantContext,
    deliverableVersionId: string,
  ): Promise<readonly ApprovalRow[]>;
}

export async function assertVersionOpenable(
  runner: TenantQueryRunner,
  context: TenantContext,
  deps: {
    readonly approvals: ApprovalsByVersion;
    readonly versions: Pick<DeliverableVersionsRepository, 'latestForDeliverable'>;
  },
  input: {
    readonly deliverableId: string;
    readonly deliverableVersionId: string;
    readonly requesterUserId: string;
    readonly reviewerIds: readonly string[];
  },
): Promise<void> {
  const latest = await deps.versions.latestForDeliverable(runner, context, input.deliverableId);
  if (!latest || latest.id !== input.deliverableVersionId) {
    throw new ApiError(
      409,
      'conflict',
      'Only the newest version can be sent',
      undefined,
      'version_superseded',
    );
  }

  const existing = await deps.approvals.listByVersion(runner, context, input.deliverableVersionId);
  if (existing.some((a) => !approvalStateMachine.isTerminal(a.state as ApprovalState))) {
    throw new ApiError(
      409,
      'conflict',
      'This version is already waiting for approval',
      undefined,
      'approval_pending',
    );
  }
  if (existing.some((a) => a.state === 'approved' || a.state === 'changes_requested')) {
    // A decided version is final: changes requested means "upload the next version".
    throw new ApiError(
      409,
      'conflict',
      'This version has already been decided',
      undefined,
      'approval_terminal',
    );
  }

  if (input.reviewerIds.includes(input.requesterUserId)) {
    throw new ApiError(
      422,
      'validation_failed',
      'You cannot review your own request',
      [{ field: 'reviewerIds', message: 'must not include the requester' }],
      'approval_self_review',
    );
  }
}

/**
 * Can a membership with this stored role be named as an internal reviewer? A built-in internal role
 * must hold `approval.decide`; a custom role (stored as its id) is accepted here because the
 * decision itself re-checks the resolved capability through `authorize()`. A client role never is.
 */
export function mayDecideApprovals(role: string): boolean {
  if (isInternalRole(role)) return hasCapability(role, 'approval.decide');
  return !isClientRole(role);
}

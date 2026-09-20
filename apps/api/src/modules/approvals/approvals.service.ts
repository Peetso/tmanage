import { approvalStateMachine, authorize, contentHashEquals } from '@tmanage/domain';
import type { ApprovalPolicy, ApprovalState, Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { ApprovalRow } from '../../common/database/schema.js';
import {
  ApprovalNotFoundError,
  ApprovalTransitionError,
  ApprovalVersionConflictError,
} from './approvals.repository.js';
import type { ApprovalsRepository } from './approvals.repository.js';
import { DeliverableVersionNotFoundError } from './deliverable-versions.repository.js';
import type { DeliverableVersionsRepository } from './deliverable-versions.repository.js';

/**
 * FR-05's application service — the immutable-decision heart, authorized at the object layer.
 *
 * ## The reviewer relation is the gate, not the route
 *
 * `25-AUTH-AND-TENANT-ISOLATION` §8 and `packages/test-kit`'s `UNGUARDED_CAPABILITIES` are
 * explicit that `approval.decide` has no route-level guard: the coarse ceiling a `CapabilityGuard`
 * could check ("does this role hold `approval.decide` at all?") is true for every reviewer role
 * and answers nothing about *this* approval. The real question — is this principal an assigned
 * reviewer on this row — needs the row in hand, so it is asked here, through the same `authorize()`
 * every service uses, with `isAssignedReviewer` built from the approval's `reviewer_ids`
 * (AUTH-08). The controller's `@RequireCapability('approval.read')` is UX only, exactly as the
 * `moderateMessage` route reuses `conversation.read` for the object-layer `conversation.moderate`.
 *
 * ## A decision re-checks the hash and is append-only
 *
 * Opening a request captures the governed version's `content_hash`. Deciding re-reads the
 * deliverable's *current* version and compares (INT-16); when the bytes have changed under the
 * reviewer the approval is `invalidated` rather than decided (INT-17, FR-05's "changed governed
 * content … invalidates pending approval"). A terminal approval has no outbound transition, so it
 * cannot be re-decided — `approvalStateMachine` refuses it and the `0027` trigger refuses it at
 * the engine.
 *
 * Object-level refusals answer 404, not 403, for the reason `ClientRequestsService` documents: a
 * refusal must not confirm that a row the caller may not see exists.
 */

/**
 * The immutable decision record — CONTRACT-001's `ApprovalDecisionView`.
 *
 * The response for both opening a request and deciding it; the decision fields are null until the
 * approval is decided. Dates are ISO strings, the shape `JSON.stringify` emits on the wire.
 */
export interface ApprovalDecisionView {
  readonly id: string;
  readonly deliverableId: string;
  readonly deliverableVersionId: string;
  readonly contentHash: string;
  readonly state: ApprovalState;
  readonly policy: ApprovalPolicy;
  readonly reviewerIds: readonly string[];
  readonly decidedByUserId: string | null;
  readonly decidedAt: string | null;
  readonly feedback: string | null;
  readonly invalidationReason: string | null;
  readonly version: number;
}

/** What opening a request supplies. The tenant and the captured hash are not the caller's. */
export interface OpenApprovalInput {
  readonly deliverableVersionId: string;
  readonly reviewerIds: readonly string[];
  readonly policy?: ApprovalPolicy;
}

/** The reviewer's decision. `feedback` is required for `request_changes` (FR-05). */
export interface ApprovalDecisionInput {
  readonly decision: 'approve' | 'request_changes';
  /** The approval version the reviewer read — optimistic concurrency (spec §3 step 7). */
  readonly expectedVersion: number;
  readonly feedback?: string;
}

function toView(row: ApprovalRow): ApprovalDecisionView {
  return {
    id: row.id,
    deliverableId: row.deliverableId,
    deliverableVersionId: row.deliverableVersionId,
    contentHash: row.contentHash,
    state: row.state as ApprovalState,
    policy: row.policy,
    reviewerIds: row.reviewerIds,
    decidedByUserId: row.decidedByUserId,
    decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
    feedback: row.feedback,
    invalidationReason: row.invalidationReason,
    version: row.version,
  };
}

export class ApprovalsService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly approvals: ApprovalsRepository,
    private readonly deliverableVersions: DeliverableVersionsRepository,
  ) {}

  /**
   * Open a review request bound to one immutable version — `draft -> requested`.
   *
   * Authorized with `deliverable.review`, which is internal-only, so a client principal is
   * refused here (a client reviews, it does not request review). The version is read
   * tenant-scoped first, so a caller naming another tenant's version gets 404, and the hash the
   * approval captures is the version's own, not a value from the request body.
   */
  async open(
    context: TenantContext,
    principal: Principal,
    input: OpenApprovalInput,
  ): Promise<ApprovalDecisionView> {
    if (input.reviewerIds.length === 0) {
      throw new ApiError(400, 'validation_failed', 'A review request needs at least one reviewer', [
        { field: 'reviewerIds', message: 'must not be empty' },
      ]);
    }

    const row = await this.guarding(() =>
      this.database.transaction(context, async (tx) => {
        const version = await this.deliverableVersions.requireById(
          tx,
          context,
          input.deliverableVersionId,
        );

        const verdict = authorize({
          principal,
          capability: 'deliverable.review',
          resource: {
            organizationId: context.organizationId,
            projectId: version.projectId,
            audience: 'client_visible',
            lifecycle: 'active',
          },
        });
        if (!verdict.allowed) {
          throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, verdict.code);
        }

        return this.approvals.open(tx, context, {
          projectId: version.projectId,
          deliverableId: version.deliverableId,
          deliverableVersionId: version.id,
          contentHash: version.contentHash,
          reviewerIds: input.reviewerIds,
          ...(input.policy ? { policy: input.policy } : {}),
        });
      }),
    );

    return toView(row);
  }

  /**
   * Decide an approval — the authorized, hash-checked, append-only heart of FR-05.
   *
   * The whole decision is one transaction: the reviewer check, the hash re-check, and the write
   * land together or not at all (spec §3 step 8). `request_changes` requires feedback; the state
   * machine refuses it without, and this maps that to a 422 the reviewer's form can render.
   */
  async decide(
    context: TenantContext,
    principal: Principal,
    approvalId: string,
    input: ApprovalDecisionInput,
  ): Promise<ApprovalDecisionView> {
    if (input.decision === 'request_changes' && (input.feedback ?? '').trim() === '') {
      throw new ApiError(422, 'validation_failed', 'Requesting changes requires feedback', [
        { field: 'feedback', message: 'must not be empty' },
      ]);
    }

    const row = await this.guarding(() =>
      this.database.transaction(context, async (tx) => {
        const approval = await this.approvals.requireById(tx, context, approvalId);

        // Object-layer authorization: the reviewer relation is the real gate (AUTH-08). A
        // non-assigned reviewer, or a principal in the wrong tenant, is refused with 404.
        const verdict = authorize({
          principal,
          capability: 'approval.decide',
          resource: {
            organizationId: context.organizationId,
            projectId: approval.projectId,
            audience: 'client_visible',
            isAssignedReviewer: approval.reviewerIds.includes(principal.userId),
            lifecycle: 'active',
          },
        });
        if (!verdict.allowed) {
          throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, verdict.code);
        }

        // Append-only: a decided (or otherwise terminal) approval cannot be re-decided.
        if (approvalStateMachine.isTerminal(approval.state as ApprovalState)) {
          throw new ApiError(
            409,
            'conflict',
            'This approval has already been resolved and cannot be decided again',
            undefined,
            'approval_terminal',
          );
        }

        if (approval.version !== input.expectedVersion) {
          throw new ApprovalVersionConflictError(approval.id, approval.version);
        }

        // The reviewer has necessarily seen the version they are deciding on: advance
        // `requested -> viewed` in the same transaction before the decision (`viewed -> …`).
        let current = approval;
        if (current.state === 'requested') {
          current = await this.approvals.transition(
            tx,
            context,
            approvalId,
            current.version,
            'viewed',
          );
        }

        // The hash re-check (INT-16/INT-17). Compare the captured hash against the deliverable's
        // *current* governed version; a mismatch (or a vanished version) invalidates.
        const governed = await this.deliverableVersions.latestForDeliverable(
          tx,
          context,
          current.deliverableId,
        );
        const hashMatches =
          governed !== null && contentHashEquals(governed.contentHash, current.contentHash);

        if (!hashMatches) {
          return this.approvals.transition(
            tx,
            context,
            approvalId,
            current.version,
            'invalidated',
            {
              invalidationReason: 'governed content changed before the decision',
            },
          );
        }

        const to: ApprovalState = input.decision === 'approve' ? 'approved' : 'changes_requested';
        return this.approvals.transition(tx, context, approvalId, current.version, to, {
          decidedByUserId: principal.userId,
          decidedAt: new Date(),
          contentHash: current.contentHash,
          ...(input.decision === 'request_changes' ? { feedback: input.feedback } : {}),
        });
      }),
    );

    return toView(row);
  }

  /**
   * Translate the repositories' thrown domain errors into the caller-facing envelope, in one
   * place, exactly as `ClientRequestsService.writing` does for its module.
   *
   * The global {@link HttpExceptionFilter} maps only the `Project*` errors, so without this the
   * approvals repositories' own throws — an absent approval, an absent deliverable version, a
   * version conflict, a refused transition — would fall through to a generic 500 `unhandled`,
   * contradicting the 404 the object-layer refusals here already promise. A not-found (a genuinely
   * absent row) and a cross-tenant scoped-read miss (another tenant's row, which `requireById`
   * reports as absent) both arrive as `ApprovalNotFoundError`/`DeliverableVersionNotFoundError`
   * and so render an identical 404 body — the same indistinguishability `MembershipResolver` keeps.
   * `auditCode` is logged, never serialised (see `errors.ts`), so it can name the precise cause
   * without leaking it. An {@link ApiError} thrown inside `work` (the authorize refusals, the
   * terminal-approval 409) is not a domain error and passes through unchanged.
   */
  private async guarding<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof ApprovalNotFoundError) {
        throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'approval_not_found');
      }
      if (error instanceof DeliverableVersionNotFoundError) {
        throw new ApiError(
          404,
          'not_found',
          MESSAGES.notFound,
          undefined,
          'deliverable_version_not_found',
        );
      }
      if (error instanceof ApprovalVersionConflictError) {
        throw new ApiError(409, 'conflict', MESSAGES.conflict, undefined, 'version_conflict');
      }
      if (error instanceof ApprovalTransitionError) {
        // A missing requirement is the reviewer's to fix (422); an illegal move is a conflict.
        const status = error.reason === 'missing_requirement' ? 422 : 409;
        const code = status === 422 ? 'validation_failed' : 'conflict';
        throw new ApiError(status, code, error.message, undefined, 'approval_transition');
      }
      throw error;
    }
  }
}

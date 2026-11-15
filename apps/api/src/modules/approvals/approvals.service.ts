import {
  approvalStateMachine,
  authorize,
  contentHashEquals,
  evaluateReviewerDecision,
  PENDING_APPROVAL_STATES,
} from '@tmanage/domain';
import type { ApprovalPolicy, ApprovalState, Principal, ReviewerDecision } from '@tmanage/domain';
import { ClientFileSharing } from '../files/client-file-sharing.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import type {
  ApprovalRow,
  ClientProjectionPayload,
  ClientProjectionRow,
} from '../../common/database/schema.js';
import {
  ApprovalNotFoundError,
  ApprovalReviewerAlreadyDecidedError,
  ApprovalTransitionError,
  ApprovalVersionConflictError,
} from './approvals.repository.js';
import type { ApprovalsRepository } from './approvals.repository.js';
import { DeliverableVersionNotFoundError } from './deliverable-versions.repository.js';
import type { DeliverableVersionsRepository } from './deliverable-versions.repository.js';
import {
  ClientProjectionAlreadyExistsError,
  ClientProjectionNotFoundError,
} from './client-projections.repository.js';
import type { ClientProjectionsRepository } from './client-projections.repository.js';
import type { OutboxEventsRepository } from '../platform/outbox-events.repository.js';
import type { AuditService } from '../audit/audit.service.js';
import { assertVersionOpenable, mayDecideApprovals } from './approval-open-preconditions.js';

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

/**
 * The client's decision from the deep-link screen. `feedback` is required for `request_changes`.
 *
 * There is no `expectedVersion`: the client reads the allowlisted projection, which does not (and
 * must not) carry the internal approval's optimistic-concurrency token. The append-only lifecycle
 * is the correctness guard instead — a version-guarded transition inside one transaction, and a
 * terminal approval that refuses a second decision — so a client cannot decide twice or race a
 * reviewer to two outcomes.
 */
export interface ClientDecisionInput {
  readonly decision: 'approve' | 'request_changes';
  readonly feedback?: string;
}

/**
 * The client-safe confirmation of a decision — CONTRACT-001's `ClientDecideView`.
 *
 * Deliberately **not** {@link ApprovalDecisionView}: that record carries `reviewerIds`,
 * `decidedByUserId`, `contentHash` and the internal `deliverableId`, none of which a client route
 * may return (25 §7 forbids handing a client the internal record). This is the version the client
 * decided on, the resulting lifecycle `state`, and — for a change request — the note they wrote.
 * `decidedAt` is an ISO string, the shape `JSON.stringify` emits on the wire.
 */
export interface ClientDecideView {
  readonly deliverableVersionId: string;
  readonly state: ApprovalState;
  readonly decidedAt: string | null;
  readonly feedback: string | null;
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

/**
 * The immutable client projection — x97's `ClientProjectionView`.
 *
 * The response for both publishing a version and reading its projection. `projection` carries only
 * the allowlisted client-safe fields (12-PERMISSION-MATRIX §1); `publishedAt` is an ISO string, the
 * shape `JSON.stringify` emits on the wire.
 */
export interface ClientProjectionView {
  readonly id: string;
  readonly deliverableId: string;
  readonly deliverableVersionId: string;
  readonly contentHash: string;
  readonly projection: ClientProjectionPayload;
  readonly publishedByUserId: string;
  readonly publishedAt: string;
}

/**
 * The projection as a reader opens it: plus whether this reader is being asked to decide. A
 * version shared with the client without "Send for approval" has no approval, so it opens as plain
 * viewing; only a pending approval naming the client (or a staff preview of one) shows the
 * decision.
 */
export interface ClientProjectionReadView extends ClientProjectionView {
  readonly awaitingDecision: boolean;
}

/** The approval states in which a reviewer may still be asked to decide. */
const PENDING_DECISION: ReadonlySet<string> = new Set(PENDING_APPROVAL_STATES);

/**
 * Whether `principal` should be offered approve / request changes on a version whose approval is
 * `approval` — the same facts `clientDecide` gates on (a pending approval, the client among its
 * reviewers), so the screen never offers a decision the API would refuse. Staff previewing the
 * portal see what the client sees whenever any approval is pending.
 */
export function awaitsClientDecision(approval: ApprovalRow | null, principal: Principal): boolean {
  if (!approval || !PENDING_DECISION.has(approval.state)) return false;
  return principal.kind !== 'client' || approval.reviewerIds.includes(principal.userId);
}

/** What publishing supplies. The tenant and the frozen hash are not the caller's. */
export interface PublishProjectionInput {
  readonly deliverableVersionId: string;
  /** The client-safe payload — allowlisted at the controller (12-PERMISSION-MATRIX §1). */
  readonly projection: ClientProjectionPayload;
}

function toClientDecideView(row: ApprovalRow): ClientDecideView {
  return {
    deliverableVersionId: row.deliverableVersionId,
    state: row.state as ApprovalState,
    decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
    feedback: row.feedback,
  };
}

function toProjectionView(row: ClientProjectionRow): ClientProjectionView {
  return {
    id: row.id,
    deliverableId: row.deliverableId,
    deliverableVersionId: row.deliverableVersionId,
    contentHash: row.contentHash,
    projection: row.projection,
    publishedByUserId: row.publishedByUserId,
    publishedAt: row.publishedAt.toISOString(),
  };
}

export class ApprovalsService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly approvals: ApprovalsRepository,
    private readonly deliverableVersions: DeliverableVersionsRepository,
    private readonly clientProjections: ClientProjectionsRepository,
    /** Q3: optional so the fakes-only tests construct without them; the module injects both. */
    private readonly outbox?: OutboxEventsRepository,
    private readonly audit?: AuditService,
    /** FIX6 item 1. The one rule that decides whether a file may reach a client. */
    private readonly sharing: ClientFileSharing = new ClientFileSharing(undefined),
  ) {}

  /**
   * Open a review request bound to one immutable version — `draft -> requested`.
   *
   * Authorized with `deliverable.review` and `deliverable.publish`, both internal-only, so a client
   * principal is refused here (a client reviews, it does not request review). Wave 9 (F16/F17): the
   * version must pass {@link assertVersionOpenable} — the rules `send` applies — and every reviewer
   * must be an internal project member who can approve, never the requester. The version is read
   * tenant-scoped first, so a caller naming another tenant's version gets 404, and the hash the
   * approval captures is the version's own, not a value from the request body.
   */
  async open(
    context: TenantContext,
    principal: Principal,
    input: OpenApprovalInput,
  ): Promise<ApprovalDecisionView> {
    const reviewerIds = [...new Set(input.reviewerIds)];
    if (reviewerIds.length === 0) {
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

        // F17: opening an approval that governs the deliverable's state is the same act as sending
        // it, so it needs `deliverable.publish` as well as `deliverable.review` (both internal-only).
        for (const capability of ['deliverable.review', 'deliverable.publish'] as const) {
          const verdict = authorize({
            principal,
            capability,
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
        }

        // F16/F17: the same lifecycle rules `send` applies — newest version only, nothing pending
        // or decided on it, and the requester is not their own reviewer.
        await assertVersionOpenable(
          tx,
          context,
          { approvals: this.approvals, versions: this.deliverableVersions },
          {
            deliverableId: version.deliverableId,
            deliverableVersionId: version.id,
            requesterUserId: principal.userId,
            reviewerIds,
          },
        );

        // A staff review request names internal people who can approve on this project. Client
        // approvers are asked through `send`, which also publishes what they are shown.
        const candidates = await this.approvals.internalReviewerCandidates(
          tx,
          context,
          version.projectId,
          reviewerIds,
        );
        const eligible = new Set(
          candidates.filter((c) => mayDecideApprovals(c.role)).map((c) => c.userId),
        );
        if (reviewerIds.some((id) => !eligible.has(id))) {
          throw new ApiError(
            422,
            'validation_failed',
            'A reviewer cannot approve this project',
            [{ field: 'reviewerIds', message: 'must be project members who can approve' }],
            'approval_reviewer_ineligible',
          );
        }

        return this.approvals.open(tx, context, {
          projectId: version.projectId,
          deliverableId: version.deliverableId,
          deliverableVersionId: version.id,
          contentHash: version.contentHash,
          reviewerIds,
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

        // A stale form is a conflict; a terminal row answers `approval_terminal` (below) instead.
        if (
          approval.version !== input.expectedVersion &&
          !approvalStateMachine.isTerminal(approval.state as ApprovalState)
        ) {
          throw new ApprovalVersionConflictError(approval.id, approval.version);
        }

        const outcome = await this.applyReviewerDecision(tx, context, approval, principal, input);
        if (outcome.final) {
          // The sender is the projection's publisher; a version never published (a staff-only
          // review) falls back to whoever uploaded it.
          const projection =
            this.outbox || this.audit
              ? await this.clientProjections.findByVersion(
                  tx,
                  context,
                  outcome.row.deliverableVersionId,
                )
              : null;
          await this.recordDecision(
            tx,
            context,
            outcome.row,
            projection?.publishedByUserId ?? outcome.uploadedByUserId,
          );
        }
        return outcome.row;
      }),
    );

    return toView(row);
  }

  /**
   * One reviewer's decision, counted by the approval's policy (F15) — shared by the staff route and
   * the client deep link.
   *
   * The approval must not be terminal (append-only). The reviewer must be a named reviewer who has
   * not decided yet, and under `ordered_sequence` the earliest undecided one (409 otherwise). The
   * first decision advances `requested -> viewed`; a changed governed hash invalidates instead of
   * recording anything (INT-16/INT-17). Otherwise the reviewer's own decision is recorded in
   * `approval_reviewer_decisions` and the approval moves to `approved` / `changes_requested` only
   * when the aggregate is final — until then it stays `viewed` with its version bumped.
   */
  private async applyReviewerDecision(
    tx: TenantQueryRunner,
    context: TenantContext,
    approval: ApprovalRow,
    principal: Principal,
    input: { readonly decision: 'approve' | 'request_changes'; readonly feedback?: string },
  ): Promise<{
    readonly row: ApprovalRow;
    readonly final: boolean;
    readonly uploadedByUserId: string;
  }> {
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

    const decision: ReviewerDecision =
      input.decision === 'approve' ? 'approved' : 'changes_requested';
    const recorded = await this.approvals.reviewerDecisions(tx, context, approval.id);
    const verdict = evaluateReviewerDecision(
      approval.policy,
      approval.reviewerIds,
      recorded,
      principal.userId,
      decision,
    );
    if (!verdict.ok) {
      if (verdict.reason === 'not_a_reviewer') {
        throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'not_assigned_reviewer');
      }
      if (verdict.reason === 'already_decided') {
        throw new ApiError(
          409,
          'conflict',
          'You have already decided on this version',
          undefined,
          'reviewer_already_decided',
        );
      }
      throw new ApiError(
        409,
        'conflict',
        'Another reviewer decides before you',
        undefined,
        'reviewer_out_of_turn',
      );
    }

    // The reviewer has necessarily seen the version they are deciding on: advance
    // `requested -> viewed` in the same transaction before the decision (`viewed -> …`).
    let current = approval;
    if (current.state === 'requested') {
      current = await this.approvals.transition(
        tx,
        context,
        approval.id,
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
    if (governed === null || !contentHashEquals(governed.contentHash, current.contentHash)) {
      const invalidated = await this.approvals.transition(
        tx,
        context,
        approval.id,
        current.version,
        'invalidated',
        { invalidationReason: 'governed content changed before the decision' },
      );
      return { row: invalidated, final: false, uploadedByUserId: '' };
    }

    const decidedAt = new Date();
    await this.approvals.recordReviewerDecision(tx, context, {
      approvalId: approval.id,
      reviewerUserId: principal.userId,
      decision,
      decidedAt,
    });

    if (verdict.aggregate === 'pending') {
      // Others still have to decide: the approval stays `viewed`; the version bump serialises two
      // reviewers racing on it (the loser's transaction conflicts and rolls back).
      const touched = await this.approvals.touch(tx, context, approval.id, current.version);
      return { row: touched, final: false, uploadedByUserId: governed.createdByUserId };
    }

    const decided = await this.approvals.transition(
      tx,
      context,
      approval.id,
      current.version,
      verdict.aggregate,
      {
        decidedByUserId: principal.userId,
        decidedAt,
        contentHash: current.contentHash,
        ...(input.decision === 'request_changes' ? { feedback: input.feedback } : {}),
      },
    );
    return { row: decided, final: true, uploadedByUserId: governed.createdByUserId };
  }

  /**
   * Decide from the client deep link — FR-05's client-facing approve / request-changes.
   *
   * The client route is **version-addressed**: it names the `deliverableVersionId` of the
   * projection the client is looking at, never an internal approval id. The version-scoped
   * projection and its approval are therefore resolved tenant-scoped *first* (the Known trap:
   * a missing or cross-tenant id must be a 404 from `requireByVersion`, never a 500), and only
   * then is the decision authorized.
   *
   * ## The client relation and the named approvers are the gate
   *
   * Only a **client** principal may use this route (internal reviewers decide through `decide`),
   * and only one of the approvers `DeliverablesService.send` named: `send` stores the chosen client
   * approvers as the approval's `reviewer_ids`, so `isAssignedReviewer` is
   * `reviewer_ids.includes(caller)` exactly as on the staff route (wave 9, F14 — before, any client
   * decider on the project, or any staff member, could decide here). `authorize()` additionally
   * requires the project relation (`projectIds`) and a role holding `approval.decide` (a client
   * viewer does not). Every refusal is 404, not 403 — a refusal must not confirm the row exists.
   *
   * With several approvers the decision is counted by the approval's policy (F15,
   * {@link applyReviewerDecision}); the response `state` stays `viewed` until the outcome is final.
   *
   * The published projection is required first: a client may only decide on a version that was
   * actually published to them, so its absence (or a cross-tenant id) is the same 404.
   *
   * The decision itself is x92's transition, unchanged: the same `viewed` advance, the same
   * INT-16/INT-17 hash re-check against the current governed version, and the same append-only
   * write. The response is the client-safe {@link ClientDecideView}, never the internal record.
   */
  async clientDecide(
    context: TenantContext,
    principal: Principal,
    deliverableVersionId: string,
    input: ClientDecisionInput,
  ): Promise<ClientDecideView> {
    if (input.decision === 'request_changes' && (input.feedback ?? '').trim() === '') {
      throw new ApiError(422, 'validation_failed', 'Requesting changes requires feedback', [
        { field: 'feedback', message: 'must not be empty' },
      ]);
    }

    const row = await this.guarding(() =>
      this.database.transaction(context, async (tx) => {
        // Known trap: resolve the version-addressed resources tenant-scoped BEFORE authorize, so a
        // missing or cross-tenant id is a typed not-found (→ 404), never an unhandled 500. The
        // projection read proves the version was published to the client (it is the published act).
        const projection = await this.clientProjections.requireByVersion(
          tx,
          context,
          deliverableVersionId,
        );
        const approval = await this.approvals.requireByVersion(tx, context, deliverableVersionId);

        // F14: this is the client's route — internal reviewers decide through `decide` — and the
        // client must be one of the approvers `send` named (`reviewer_ids`), not any client decider
        // on the project.
        if (principal.kind !== 'client') {
          throw new ApiError(
            404,
            'not_found',
            MESSAGES.notFound,
            undefined,
            'not_a_client_principal',
          );
        }
        const verdict = authorize({
          principal,
          capability: 'approval.decide',
          resource: {
            organizationId: context.organizationId,
            projectId: projection.projectId,
            audience: 'client_visible',
            isPublished: true,
            isAssignedReviewer: approval.reviewerIds.includes(principal.userId),
            lifecycle: 'active',
          },
        });
        if (!verdict.allowed) {
          throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, verdict.code);
        }

        const outcome = await this.applyReviewerDecision(tx, context, approval, principal, input);
        if (outcome.final) {
          await this.recordDecision(tx, context, outcome.row, projection.publishedByUserId);
        }
        return outcome.row;
      }),
    );

    return toClientDecideView(row);
  }

  /**
   * Publish a governed version to the client — freeze its immutable client-safe projection.
   *
   * Authorized with `deliverable.publish`, which is internal-only (25 §4, capabilities.ts), so a
   * client principal is refused here exactly as `open` refuses one for `deliverable.review`: a
   * client is published *to*, it does not publish. The version is read tenant-scoped first, so a
   * caller naming another tenant's version gets 404, and the projection freezes the version's own
   * `content_hash` — 25 §7's "publishing transactionally creates an immutable client-safe version",
   * never a hash from the request body. A second publish of the same version is refused
   * (append-only): `0031`'s UNIQUE key raises it at the engine and this maps it to 409.
   */
  async publish(
    context: TenantContext,
    principal: Principal,
    input: PublishProjectionInput,
  ): Promise<ClientProjectionView> {
    const row = await this.guarding(() =>
      this.database.transaction(context, async (tx) => {
        const version = await this.deliverableVersions.requireById(
          tx,
          context,
          input.deliverableVersionId,
        );

        const verdict = authorize({
          principal,
          capability: 'deliverable.publish',
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

        // FIX6 item 1: the version's file must be one the sharing rule lets reach a client.
        await this.sharing.assertVersionFileShareable(tx, context, version.fileAssetId);

        return this.clientProjections.publish(tx, context, {
          projectId: version.projectId,
          deliverableId: version.deliverableId,
          deliverableVersionId: version.id,
          contentHash: version.contentHash,
          projection: input.projection,
          publishedByUserId: principal.userId,
        });
      }),
    );

    return toProjectionView(row);
  }

  /**
   * Read the immutable client projection for a governed version — FR-05's authorized client read.
   *
   * Authorized with `client_projection.read` against the client relation: `authorize` admits a
   * client principal only when the projection's project is one the client organization may reach
   * (its `projectIds`) and the audience is client-visible, and an internal reader with the ceiling
   * may preview what the client sees (12-PERMISSION-MATRIX §2). The projection is read
   * tenant-scoped first, so a caller in another tenant gets 404 rather than a refusal that confirms
   * the row exists; `isPublished: true` because a `client_projections` row *is* the published act.
   */
  async readProjection(
    context: TenantContext,
    principal: Principal,
    deliverableVersionId: string,
  ): Promise<ClientProjectionReadView> {
    return this.guarding(() =>
      this.database.transaction(context, async (tx) => {
        const projection = await this.clientProjections.requireByVersion(
          tx,
          context,
          deliverableVersionId,
        );

        const verdict = authorize({
          principal,
          capability: 'client_projection.read',
          resource: {
            organizationId: context.organizationId,
            projectId: projection.projectId,
            audience: 'client_visible',
            isPublished: true,
            lifecycle: 'active',
          },
        });
        if (!verdict.allowed) {
          throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, verdict.code);
        }

        const approval = await this.approvals.findByVersion(tx, context, deliverableVersionId);
        return {
          ...toProjectionView(projection),
          awaitingDecision: awaitsClientDecision(approval, principal),
        };
      }),
    );
  }

  /**
   * Q3: tell the team and leave the trail, inside the decision's own transaction. The outbox event
   * `approval.decided.v1` lets the worker notify the sender and the project's deliverable makers;
   * the audit row records who decided what. Neither ever carries the feedback text.
   *
   * There is no `requested_by` column on `approvals`, so the requester is resolved by the caller:
   * the client projection's publisher (the person who pressed Send).
   */
  private async recordDecision(
    tx: TenantQueryRunner,
    context: TenantContext,
    decided: ApprovalRow,
    requestedByUserId: string,
  ): Promise<void> {
    if (decided.state !== 'approved' && decided.state !== 'changes_requested') return;
    const decision = decided.state;
    const decidedByUserId = decided.decidedByUserId ?? context.userId;
    await this.outbox?.append(tx, context, {
      type: 'approval.decided.v1',
      aggregateId: decided.id,
      payload: {
        approvalId: decided.id,
        deliverableId: decided.deliverableId,
        deliverableVersionId: decided.deliverableVersionId,
        projectId: decided.projectId,
        decision,
        decidedByUserId,
        requestedByUserId,
      },
    });
    await this.audit?.record(tx, context, {
      action: decision === 'approved' ? 'approval.approved' : 'approval.changes_requested',
      objectId: decided.id,
      result: 'allowed',
      metadata: {
        deliverable_id: decided.deliverableId,
        deliverable_version_id: decided.deliverableVersionId,
        project_id: decided.projectId,
      },
    });
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
      if (error instanceof ClientProjectionNotFoundError) {
        throw new ApiError(
          404,
          'not_found',
          MESSAGES.notFound,
          undefined,
          'client_projection_not_found',
        );
      }
      if (error instanceof ClientProjectionAlreadyExistsError) {
        // Append-only: the governed version already has a projection. A conflict, not a 500.
        throw new ApiError(
          409,
          'conflict',
          'This version has already been published to the client',
          undefined,
          'client_projection_exists',
        );
      }
      if (error instanceof ApprovalVersionConflictError) {
        throw new ApiError(409, 'conflict', MESSAGES.conflict, undefined, 'version_conflict');
      }
      if (error instanceof ApprovalReviewerAlreadyDecidedError) {
        // A concurrent second decision by the same reviewer, refused by the 0235 UNIQUE key.
        throw new ApiError(
          409,
          'conflict',
          'You have already decided on this version',
          undefined,
          'reviewer_already_decided',
        );
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

import { StateMachine, type StateMachineDefinition } from './state-machine.js';

/** `23-ERD-AND-STATE-MACHINES.md` §8. */
export const APPROVAL_STATES = [
  'draft',
  'requested',
  'viewed',
  'approved',
  'changes_requested',
  'expired',
  'cancelled',
  'invalidated',
] as const;

export type ApprovalState = (typeof APPROVAL_STATES)[number];

const definition: StateMachineDefinition<ApprovalState> = {
  name: 'approval',
  initial: 'draft',
  states: APPROVAL_STATES,
  terminal: ['approved', 'changes_requested', 'expired', 'cancelled', 'invalidated'],
  transitions: [
    {
      from: 'draft',
      to: 'requested',
      requires: ['deliverableVersionId', 'contentHash', 'reviewerIds'],
      note:
        '§8 + FR-05: a request is bound to exactly one immutable deliverable version and its ' +
        'content hash at the moment of request.',
    },
    { from: 'requested', to: 'viewed' },
    { from: 'requested', to: 'expired' },
    { from: 'requested', to: 'cancelled', requires: ['cancellationReason'] },
    {
      from: 'requested',
      to: 'invalidated',
      requires: ['invalidationReason'],
      note: '§8: governed content changed before the reviewer opened it.',
    },
    {
      from: 'viewed',
      to: 'approved',
      requires: ['decidedByUserId', 'decidedAt', 'contentHash'],
      note:
        'US-C03: approval records actor, time, and the hash of the exact version reviewed. ' +
        'The hash is re-checked against the governed version inside the decision transaction.',
    },
    {
      from: 'viewed',
      to: 'changes_requested',
      requires: ['decidedByUserId', 'decidedAt', 'contentHash', 'feedback'],
      note: 'FR-05: requesting changes requires feedback.',
    },
    { from: 'viewed', to: 'expired' },
    { from: 'viewed', to: 'cancelled', requires: ['cancellationReason'] },
    {
      from: 'viewed',
      to: 'invalidated',
      requires: ['invalidationReason'],
      note:
        '§8 + FR-05: a governed content change invalidates a pending approval. It never ' +
        'silently re-points the existing request at the new version.',
    },
  ],
};

export const approvalStateMachine = new StateMachine(definition);

/** States in which a reviewer may still be asked to decide. */
export const PENDING_APPROVAL_STATES: readonly ApprovalState[] = ['requested', 'viewed'];

/**
 * How multiple reviewers combine into one approval outcome.
 * `23-ERD §8`: all-required, any-one, or an ordered sequence.
 */
export type ApprovalPolicy = 'all_required' | 'any_one' | 'ordered_sequence';

export type ReviewerDecision = 'approved' | 'changes_requested';

export interface ReviewerOutcome {
  readonly reviewerUserId: string;
  /** Position in the sequence, used only by `ordered_sequence`. Zero-based. */
  readonly sequence: number;
  readonly decision: ReviewerDecision | null;
}

export type AggregateOutcome = 'approved' | 'changes_requested' | 'pending';

/**
 * Derive the approval-level outcome from the individual reviewer decisions.
 *
 * `changes_requested` from any reviewer short-circuits under every policy: once one
 * authorized reviewer has asked for changes, the version is not approved regardless of
 * what the others say. This is deliberately stricter than a naive vote count.
 */
export function aggregateApprovalOutcome(
  policy: ApprovalPolicy,
  reviewers: readonly ReviewerOutcome[],
): AggregateOutcome {
  if (reviewers.length === 0) return 'pending';
  if (reviewers.some((r) => r.decision === 'changes_requested')) return 'changes_requested';

  switch (policy) {
    case 'all_required':
      return reviewers.every((r) => r.decision === 'approved') ? 'approved' : 'pending';

    case 'any_one':
      return reviewers.some((r) => r.decision === 'approved') ? 'approved' : 'pending';

    case 'ordered_sequence': {
      // Approved only when every reviewer has approved in order with no gap. A later
      // reviewer deciding before an earlier one does not advance the aggregate.
      const ordered = [...reviewers].sort((a, b) => a.sequence - b.sequence);
      return ordered.every((r) => r.decision === 'approved') ? 'approved' : 'pending';
    }
  }
}

/**
 * Which reviewer, if any, is currently being asked to act.
 *
 * Under `ordered_sequence` only the earliest undecided reviewer is actionable; the rest
 * must not receive an action-required notification yet, and must not be able to decide.
 */
export function activeReviewers(
  policy: ApprovalPolicy,
  reviewers: readonly ReviewerOutcome[],
): readonly ReviewerOutcome[] {
  const undecided = reviewers.filter((r) => r.decision === null);
  if (policy !== 'ordered_sequence') return undecided;

  const next = [...undecided].sort((a, b) => a.sequence - b.sequence)[0];
  return next ? [next] : [];
}

/** One reviewer's recorded decision, as the per-reviewer store holds it. */
export interface RecordedReviewerDecision {
  readonly reviewerUserId: string;
  readonly decision: ReviewerDecision;
}

/**
 * The reviewers of an approval with their recorded decisions. `sequence` is the reviewer's
 * position in `reviewerIds` (the order the requester named them), which `ordered_sequence` follows.
 * A duplicate id in `reviewerIds` counts once, at its first position.
 */
export function reviewerOutcomes(
  reviewerIds: readonly string[],
  recorded: readonly RecordedReviewerDecision[],
): readonly ReviewerOutcome[] {
  const byReviewer = new Map(recorded.map((r) => [r.reviewerUserId, r.decision] as const));
  const seen = new Set<string>();
  const out: ReviewerOutcome[] = [];
  for (const reviewerUserId of reviewerIds) {
    if (seen.has(reviewerUserId)) continue;
    seen.add(reviewerUserId);
    out.push({
      reviewerUserId,
      sequence: out.length,
      decision: byReviewer.get(reviewerUserId) ?? null,
    });
  }
  return out;
}

export type ReviewerDecisionRefusal = 'not_a_reviewer' | 'already_decided' | 'not_your_turn';

export type ReviewerDecisionVerdict =
  | {
      readonly ok: true;
      /** The approval-level outcome once this decision is counted. `pending` = not final yet. */
      readonly aggregate: AggregateOutcome;
    }
  | { readonly ok: false; readonly reason: ReviewerDecisionRefusal };

/**
 * May `reviewerUserId` record `decision` on an approval now, and what does the approval become?
 *
 * Refuses a principal who is not one of the named reviewers, a reviewer who already decided, and,
 * under `ordered_sequence`, a reviewer whose turn has not come (only the earliest undecided reviewer
 * may act). Otherwise counts the decision and returns {@link aggregateApprovalOutcome}: `any_one`
 * is final on the first decision, `all_required` on the first change request or the last approval,
 * `ordered_sequence` likewise but in order. The approval moves to a terminal state only when the
 * aggregate is not `pending` (`23-ERD §8`).
 */
export function evaluateReviewerDecision(
  policy: ApprovalPolicy,
  reviewerIds: readonly string[],
  recorded: readonly RecordedReviewerDecision[],
  reviewerUserId: string,
  decision: ReviewerDecision,
): ReviewerDecisionVerdict {
  const outcomes = reviewerOutcomes(reviewerIds, recorded);
  const self = outcomes.find((r) => r.reviewerUserId === reviewerUserId);
  if (!self) return { ok: false, reason: 'not_a_reviewer' };
  if (self.decision !== null) return { ok: false, reason: 'already_decided' };
  if (!activeReviewers(policy, outcomes).some((r) => r.reviewerUserId === reviewerUserId)) {
    return { ok: false, reason: 'not_your_turn' };
  }
  const after = outcomes.map((r) => (r.reviewerUserId === reviewerUserId ? { ...r, decision } : r));
  return { ok: true, aggregate: aggregateApprovalOutcome(policy, after) };
}

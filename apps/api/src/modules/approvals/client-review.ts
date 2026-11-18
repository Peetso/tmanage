import { PENDING_APPROVAL_STATES } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import type { ApprovalRow } from '../../common/database/schema.js';

/**
 * Where a published version's review stands for the client — read from its live approval, never
 * from the projection. The projection is frozen at publish (0031) and the product publishes its
 * `decision` as null, so a client screen that read the projection said "none final yet" after
 * every approval and kept offering an already-decided version as "Your turn" (TESTUX P1 4/5).
 *
 * `awaiting_decision` is a pending approval; `approved` and `changes_requested` are its outcomes.
 * A version shared without "Send for approval", or one whose approval was cancelled, expired or
 * invalidated, has no review to show.
 */
export type ClientReviewState = 'awaiting_decision' | 'approved' | 'changes_requested';

export interface ClientReview {
  readonly state: ClientReviewState;
  /** The decision is this reader's to make now ({@link awaitsClientDecision}). */
  readonly awaitingYou: boolean;
}

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

/** The client-safe review of one version, from its newest approval (or none). */
export function clientReviewOf(
  approval: ApprovalRow | null,
  principal: Principal,
): ClientReview | null {
  if (!approval) return null;
  if (PENDING_DECISION.has(approval.state)) {
    return { state: 'awaiting_decision', awaitingYou: awaitsClientDecision(approval, principal) };
  }
  if (approval.state === 'approved' || approval.state === 'changes_requested') {
    return { state: approval.state, awaitingYou: false };
  }
  return null;
}

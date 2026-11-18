import type { ClientReview } from './api/approvals';
import type { MessageKey } from './i18n/t';

/**
 * How the client portal names a published version's live review (TESTUX P1 4/5). One rule for
 * every portal screen — the overview, the deliverables list and the review page — so they never
 * disagree about what is final or whose turn it is. The review is the API's, read from the
 * approval; the projection's frozen `decision` is never consulted.
 */

/** Approved: the version is final. */
export function isFinalReview(review: ClientReview | null): boolean {
  return review?.state === 'approved';
}

/** The decision is this client's to make now. */
export function awaitsYou(review: ClientReview | null): boolean {
  return review?.awaitingYou === true;
}

/** The status word of a version under review. */
export function reviewLabelKey(review: ClientReview): MessageKey {
  switch (review.state) {
    case 'approved':
      return 'PortalReview.approved';
    case 'changes_requested':
      return 'PortalReview.changesAsked';
    case 'awaiting_decision':
      return review.awaitingYou ? 'PortalReview.yourDecision' : 'PortalReview.inReview';
  }
}

import { describe, expect, it } from 'vitest';
import { evaluateReviewerDecision, reviewerOutcomes } from './approval.js';

/**
 * Wave 9 S5 (audit run 1, F15): a multi-reviewer approval is decided by its policy, not by the
 * first reviewer who answers.
 */
const A = 'reviewer-a';
const B = 'reviewer-b';

describe('evaluateReviewerDecision (F15)', () => {
  it('all_required: one of two approvals is not final; the second makes it approved', () => {
    const first = evaluateReviewerDecision('all_required', [A, B], [], B, 'approved');
    expect(first).toEqual({ ok: true, aggregate: 'pending' });

    const second = evaluateReviewerDecision(
      'all_required',
      [A, B],
      [{ reviewerUserId: B, decision: 'approved' }],
      A,
      'approved',
    );
    expect(second).toEqual({ ok: true, aggregate: 'approved' });
  });

  it('all_required: the first change request is final', () => {
    expect(evaluateReviewerDecision('all_required', [A, B], [], A, 'changes_requested')).toEqual({
      ok: true,
      aggregate: 'changes_requested',
    });
  });

  it('ordered_sequence: the second reviewer may not decide before the first', () => {
    expect(evaluateReviewerDecision('ordered_sequence', [A, B], [], B, 'approved')).toEqual({
      ok: false,
      reason: 'not_your_turn',
    });
    expect(evaluateReviewerDecision('ordered_sequence', [A, B], [], A, 'approved')).toEqual({
      ok: true,
      aggregate: 'pending',
    });
    expect(
      evaluateReviewerDecision(
        'ordered_sequence',
        [A, B],
        [{ reviewerUserId: A, decision: 'approved' }],
        B,
        'approved',
      ),
    ).toEqual({ ok: true, aggregate: 'approved' });
  });

  it('any_one: the first decision is final, as before', () => {
    expect(evaluateReviewerDecision('any_one', [A, B], [], B, 'approved')).toEqual({
      ok: true,
      aggregate: 'approved',
    });
  });

  it('refuses a reviewer who already decided, and a principal who is not a reviewer', () => {
    const recorded = [{ reviewerUserId: A, decision: 'approved' as const }];
    expect(evaluateReviewerDecision('all_required', [A, B], recorded, A, 'approved')).toEqual({
      ok: false,
      reason: 'already_decided',
    });
    expect(evaluateReviewerDecision('all_required', [A, B], [], 'outsider', 'approved')).toEqual({
      ok: false,
      reason: 'not_a_reviewer',
    });
  });

  it('counts a duplicated reviewer id once, at its first position', () => {
    expect(reviewerOutcomes([A, B, A], []).map((r) => [r.reviewerUserId, r.sequence])).toEqual([
      [A, 0],
      [B, 1],
    ]);
  });
});

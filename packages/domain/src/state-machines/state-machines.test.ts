import { describe, expect, it } from 'vitest';
import { StateMachine } from './state-machine.js';
import { workItemStateMachine, WORK_ITEM_STATES } from './work-item.js';
import { clientRequestStateMachine } from './client-request.js';
import { deliverableStateMachine } from './deliverable.js';
import {
  activeReviewers,
  aggregateApprovalOutcome,
  approvalStateMachine,
  type ReviewerOutcome,
} from './approval.js';
import { isServable, isServableVersion, uploadStateMachine, UPLOAD_STATES } from './upload.js';
import { invitationStateMachine } from './invitation.js';
import { offboardingStateMachine } from './offboarding.js';
import { StateMachine } from './state-machine.js';

describe('StateMachine core', () => {
  it('refuses to build a machine with a duplicated transition', () => {
    expect(
      () =>
        new StateMachine({
          name: 'broken',
          initial: 'a',
          states: ['a', 'b'],
          terminal: ['b'],
          transitions: [
            { from: 'a', to: 'b', requires: ['reason'] },
            { from: 'a', to: 'b' },
          ],
        }),
    ).toThrow(/duplicate transition/);
  });

  it('treats a whitespace-only string as an unsupplied requirement', () => {
    const result = workItemStateMachine.transition('in_progress', 'blocked', {
      blockerReason: '   ',
      blockerAsk: 'Need copy from Noor',
    });

    expect(result).toMatchObject({ ok: false, reason: 'missing_requirement' });
    if (!result.ok) expect(result.missing).toEqual(['blockerReason']);
  });
});

describe('work item lifecycle (23-ERD §5)', () => {
  it('walks the default path', () => {
    expect(workItemStateMachine.transition('backlog', 'ready').ok).toBe(true);
    expect(workItemStateMachine.transition('ready', 'in_progress').ok).toBe(true);
    expect(workItemStateMachine.transition('in_progress', 'internal_review').ok).toBe(true);
  });

  it('requires an owner and completion timestamp to reach done', () => {
    const missing = workItemStateMachine.transition('internal_review', 'done', {});
    expect(missing).toMatchObject({ ok: false, reason: 'missing_requirement' });
    if (!missing.ok) expect(missing.missing).toEqual(['ownerId', 'completedAt']);

    expect(
      workItemStateMachine.transition('internal_review', 'done', {
        ownerId: 'u1',
        completedAt: '2026-08-16T10:00:00Z',
      }).ok,
    ).toBe(true);
  });

  it('offers the blocker owner as an optional fact, and demands it nowhere', () => {
    // US-B04 wants the owner of the ask; §5 does not require one. The machine says so as
    // data, so a form can offer the field without the rule living in the form.
    expect(workItemStateMachine.optionalFor('in_progress', 'blocked')).toEqual([
      'blockerOwnerUserId',
    ]);
    expect(workItemStateMachine.requirementsFor('in_progress', 'blocked')).not.toContain(
      'blockerOwnerUserId',
    );
    expect(workItemStateMachine.optionalFor('internal_review', 'done')).toEqual([]);
    expect(workItemStateMachine.optionalFor('done', 'backlog')).toEqual([]);
  });

  it('refuses a definition that lists one fact as both required and optional', () => {
    expect(
      () =>
        new StateMachine({
          name: 'contradiction',
          initial: 'a',
          states: ['a', 'b'],
          terminal: ['b'],
          transitions: [{ from: 'a', to: 'b', requires: ['why'], accepts: ['why'] }],
        }),
    ).toThrow(/both required and optional/);
  });

  it('requires a reason and an ask to enter blocked, and a resolution to leave it', () => {
    expect(workItemStateMachine.transition('in_progress', 'blocked', {}).ok).toBe(false);
    expect(
      workItemStateMachine.transition('in_progress', 'blocked', {
        blockerReason: 'Awaiting Arabic copy',
        blockerAsk: 'Noor to deliver FAQ text',
      }).ok,
    ).toBe(true);

    expect(workItemStateMachine.transition('blocked', 'in_progress', {}).ok).toBe(false);
    expect(
      workItemStateMachine.transition('blocked', 'in_progress', {
        blockerResolution: 'Copy received',
      }).ok,
    ).toBe(true);
  });

  it('requires a reason to reopen a done item', () => {
    expect(workItemStateMachine.transition('done', 'in_progress', {}).ok).toBe(false);
    expect(
      workItemStateMachine.transition('done', 'in_progress', { reopenReason: 'CTA regression' }).ok,
    ).toBe(true);
  });

  it('rejects transitions the spec does not list', () => {
    // Skipping internal review straight to done would bypass the review gate entirely.
    expect(workItemStateMachine.transition('in_progress', 'done', {})).toMatchObject({
      ok: false,
      reason: 'illegal_transition',
    });
    expect(workItemStateMachine.transition('backlog', 'in_progress')).toMatchObject({
      ok: false,
      reason: 'illegal_transition',
    });
  });

  it('leaves the archive only by a restore to the backlog', () => {
    for (const target of WORK_ITEM_STATES) {
      expect(workItemStateMachine.transition('archived', target).ok).toBe(target === 'backlog');
    }
    expect(workItemStateMachine.isTerminal('archived')).toBe(false);
  });
});

describe('client request lifecycle (23-ERD §6)', () => {
  it('requires a client-safe reason to decline or defer', () => {
    for (const target of ['declined', 'deferred'] as const) {
      expect(clientRequestStateMachine.transition('triage', target, {}).ok).toBe(false);
      expect(
        clientRequestStateMachine.transition('triage', target, {
          clientVisibleReason: 'Capacity is committed through September.',
        }).ok,
      ).toBe(true);
    }
  });

  it('requires scope, commitment, and linked work to accept', () => {
    const result = clientRequestStateMachine.transition('triage', 'accepted', {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.missing).toEqual(['clientSafeScopeSummary', 'commitment', 'linkedWorkItemId']);
    }

    expect(
      clientRequestStateMachine.transition('triage', 'accepted', {
        clientSafeScopeSummary: 'Arabic booking FAQ, 6 questions, EN/AR parity.',
        commitment: { kind: 'committed', date: '2026-09-03' },
        linkedWorkItemId: 'w1',
      }).ok,
    ).toBe(true);
  });

  it('cannot be withdrawn once delivered', () => {
    expect(clientRequestStateMachine.transition('delivered', 'withdrawn').ok).toBe(false);
  });

  it('cannot jump from submitted straight to accepted, skipping triage', () => {
    expect(clientRequestStateMachine.transition('submitted', 'accepted', {})).toMatchObject({
      ok: false,
      reason: 'illegal_transition',
    });
  });
});

describe('deliverable lifecycle (23-ERD §7)', () => {
  it('requires an internal reviewer before the deliverable is client-ready', () => {
    expect(deliverableStateMachine.transition('internal_review', 'ready_for_client', {}).ok).toBe(
      false,
    );
    expect(
      deliverableStateMachine.transition('internal_review', 'ready_for_client', {
        internalReviewerUserId: 'u-omar',
        internalReviewedAt: '2026-08-16T09:00:00Z',
      }).ok,
    ).toBe(true);
  });

  it('cannot enter client review without a projection and reviewers', () => {
    expect(deliverableStateMachine.transition('ready_for_client', 'client_review', {}).ok).toBe(
      false,
    );
  });

  it('cannot be finalised from an approved state without recording who and when', () => {
    expect(deliverableStateMachine.transition('approved', 'final', {}).ok).toBe(false);
    expect(
      deliverableStateMachine.transition('approved', 'final', {
        finalizedByUserId: 'u-omar',
        finalizedAt: '2026-09-30T12:00:00Z',
      }).ok,
    ).toBe(true);
  });

  it('permits the waiver path to final only with a rationale and an authorizer', () => {
    const partial = deliverableStateMachine.transition('ready_for_client', 'final', {
      finalizedByUserId: 'u-omar',
      finalizedAt: '2026-09-30T12:00:00Z',
    });
    expect(partial.ok).toBe(false);
    if (!partial.ok) {
      expect(partial.missing).toEqual(['waiverReason', 'waiverAuthorizedByUserId']);
    }

    expect(
      deliverableStateMachine.transition('ready_for_client', 'final', {
        finalizedByUserId: 'u-omar',
        finalizedAt: '2026-09-30T12:00:00Z',
        waiverReason: 'Client confirmed verbally at launch review; recorded in decision log.',
        waiverAuthorizedByUserId: 'u-maya',
      }).ok,
    ).toBe(true);
  });

  it('cannot skip client review to reach approved', () => {
    expect(deliverableStateMachine.transition('ready_for_client', 'approved', {})).toMatchObject({
      ok: false,
      reason: 'illegal_transition',
    });
  });
});

describe('approval lifecycle (23-ERD §8)', () => {
  it('binds a request to a version and hash', () => {
    expect(approvalStateMachine.transition('draft', 'requested', {}).ok).toBe(false);
    expect(
      approvalStateMachine.transition('draft', 'requested', {
        deliverableVersionId: 'dv2',
        contentHash: 'a'.repeat(64),
        reviewerIds: ['u-youssef'],
      }).ok,
    ).toBe(true);
  });

  it('requires feedback to request changes but not to approve', () => {
    const base = {
      decidedByUserId: 'u-youssef',
      decidedAt: '2026-08-18T11:00:00Z',
      contentHash: 'a'.repeat(64),
    };

    expect(approvalStateMachine.transition('viewed', 'approved', base).ok).toBe(true);

    const withoutFeedback = approvalStateMachine.transition('viewed', 'changes_requested', base);
    expect(withoutFeedback.ok).toBe(false);
    if (!withoutFeedback.ok) expect(withoutFeedback.missing).toEqual(['feedback']);
  });

  it('cannot decide directly from requested without the version being viewed', () => {
    expect(approvalStateMachine.transition('requested', 'approved', {})).toMatchObject({
      ok: false,
      reason: 'illegal_transition',
    });
  });

  it('has no transition out of any terminal state, so a decision cannot be overwritten', () => {
    for (const terminal of ['approved', 'changes_requested', 'invalidated', 'expired'] as const) {
      expect(approvalStateMachine.allowedFrom(terminal)).toEqual([]);
    }
  });

  it('requires a reason to invalidate', () => {
    expect(approvalStateMachine.transition('viewed', 'invalidated', {}).ok).toBe(false);
    expect(
      approvalStateMachine.transition('viewed', 'invalidated', {
        invalidationReason: 'Governed version replaced by v3',
      }).ok,
    ).toBe(true);
  });
});

describe('approval aggregation', () => {
  const reviewer = (sequence: number, decision: ReviewerOutcome['decision']): ReviewerOutcome => ({
    reviewerUserId: `u${sequence}`,
    sequence,
    decision,
  });

  it('any single changes_requested defeats approval under every policy', () => {
    const reviewers = [reviewer(0, 'approved'), reviewer(1, 'changes_requested')];

    for (const policy of ['all_required', 'any_one', 'ordered_sequence'] as const) {
      expect(aggregateApprovalOutcome(policy, reviewers)).toBe('changes_requested');
    }
  });

  it('all_required stays pending until every reviewer approves', () => {
    expect(
      aggregateApprovalOutcome('all_required', [reviewer(0, 'approved'), reviewer(1, null)]),
    ).toBe('pending');
    expect(
      aggregateApprovalOutcome('all_required', [reviewer(0, 'approved'), reviewer(1, 'approved')]),
    ).toBe('approved');
  });

  it('any_one approves on the first approval', () => {
    expect(aggregateApprovalOutcome('any_one', [reviewer(0, 'approved'), reviewer(1, null)])).toBe(
      'approved',
    );
  });

  it('treats an empty reviewer list as pending, never as approved', () => {
    for (const policy of ['all_required', 'any_one', 'ordered_sequence'] as const) {
      expect(aggregateApprovalOutcome(policy, [])).toBe('pending');
    }
  });

  it('ordered_sequence makes only the earliest undecided reviewer actionable', () => {
    const reviewers = [reviewer(0, 'approved'), reviewer(1, null), reviewer(2, null)];

    expect(activeReviewers('ordered_sequence', reviewers).map((r) => r.sequence)).toEqual([1]);
    expect(activeReviewers('all_required', reviewers).map((r) => r.sequence)).toEqual([1, 2]);
  });
});

describe('upload lifecycle (23-ERD §10)', () => {
  it('marks only `ready` as servable', () => {
    for (const state of UPLOAD_STATES) {
      expect(isServable(state), `${state} servability`).toBe(state === 'ready');
    }
  });

  it('serves a version only when ready, clean and private hold together (FILE-002 slice C)', () => {
    const verdicts = ['clean', 'infected', 'unscanned', null];
    const zones = ['quarantine', 'private', 'derived'];
    let admitted = 0;
    for (const status of UPLOAD_STATES) {
      for (const scanVerdict of verdicts) {
        for (const trustZone of zones) {
          const servable = isServableVersion({ status, scanVerdict, trustZone });
          if (servable) admitted += 1;
          expect(servable, `${status}/${scanVerdict}/${trustZone}`).toBe(
            status === 'ready' && scanVerdict === 'clean' && trustZone === 'private',
          );
        }
      }
    }
    expect(admitted).toBe(1);
    // Reversal: a status the machine does not know is never servable either.
    expect(isServableVersion({ status: 'READY', scanVerdict: 'clean', trustZone: 'private' })).toBe(
      false,
    );
  });

  it('cannot reach ready without a recorded scan verdict', () => {
    expect(uploadStateMachine.transition('scanning', 'ready', {}).ok).toBe(false);
    expect(
      uploadStateMachine.transition('scanning', 'ready', {
        scanVerdict: 'clean',
        scannedAt: '2026-08-16T10:05:00Z',
      }).ok,
    ).toBe(true);
  });

  it('cannot skip verification and scanning to become ready', () => {
    expect(uploadStateMachine.transition('uploaded', 'ready', {})).toMatchObject({
      ok: false,
      reason: 'illegal_transition',
    });
    expect(uploadStateMachine.transition('verifying', 'ready', {})).toMatchObject({
      ok: false,
      reason: 'illegal_transition',
    });
  });
});

describe('invitation lifecycle (23-ERD §9)', () => {
  it('is single-use: acceptance is terminal', () => {
    expect(invitationStateMachine.allowedFrom('accepted')).toEqual([]);
  });

  it('cannot revive a revoked or expired invitation', () => {
    expect(invitationStateMachine.transition('revoked', 'pending').ok).toBe(false);
    expect(invitationStateMachine.transition('expired', 'accepted', {}).ok).toBe(false);
  });
});

describe('offboarding lifecycle (23-ERD §11)', () => {
  it('cannot transfer work before sessions are revoked', () => {
    const result = offboardingStateMachine.transition('suspending', 'transferring', {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.missing).toEqual(['sessionsRevokedAt']);
  });

  it('never restores access automatically from a partial failure', () => {
    expect(offboardingStateMachine.allowedFrom('failed_partial')).toEqual([]);
  });

  it('requires a completion receipt to complete', () => {
    expect(
      offboardingStateMachine.transition('reviewing_external_access', 'completed', {}).ok,
    ).toBe(false);
    expect(
      offboardingStateMachine.transition('reviewing_external_access', 'completed', {
        completionReceiptId: 'r1',
      }).ok,
    ).toBe(true);
  });
});

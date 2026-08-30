import { describe, expect, it } from 'vitest';
import { clientRequestStateMachine } from '@tmanage/domain';
import { WORKER_OUTBOX_HANDLERS } from './registry.js';
import { requestTransitionFor } from './work-item-lifecycle.js';

/**
 * The pure half of the lifecycle rule. What it does to real rows — idempotent replay,
 * the audit row with a NULL actor, the transitioned event it emits — is proved against a
 * real server in `apps/api/test/plat-004-relay.db.test.ts`.
 */

describe('requestTransitionFor', () => {
  it('maps in_progress to accepted -> planned', () => {
    expect(requestTransitionFor('in_progress')).toEqual({ from: 'accepted', to: 'planned' });
  });

  it('maps done to planned -> delivered', () => {
    expect(requestTransitionFor('done')).toEqual({ from: 'planned', to: 'delivered' });
  });

  it('reads no other work-item state', () => {
    for (const state of ['backlog', 'ready', 'blocked', 'internal_review', 'archived']) {
      expect(requestTransitionFor(state), state).toBeNull();
    }
  });

  it('proposes only transitions the state machine has', () => {
    // The consumer asks the machine before writing; this pins that the answer is yes for
    // every transition the rule can propose, so a future edit to §6's arrows is caught by
    // a fast test as well as by the parked events it would produce.
    for (const state of ['in_progress', 'done']) {
      const rule = requestTransitionFor(state);
      expect(rule).not.toBeNull();
      if (rule) {
        expect(clientRequestStateMachine.transition(rule.from, rule.to).ok).toBe(true);
      }
    }
  });
});

describe('the handler registry', () => {
  it('answers to exactly the types its consumers read', () => {
    expect(Object.keys(WORKER_OUTBOX_HANDLERS).sort()).toEqual([
      'client_request.submitted.v1',
      'client_request.transitioned.v1',
      'work_item.blocked.v1',
      'work_item.updated.v1',
    ]);
  });
});

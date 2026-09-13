import { describe, expect, it } from 'vitest';
import type { WorkItemRow } from '../../common/database/schema.js';
import { progressOf } from './portal.service.js';

/**
 * The client-facing progress projection (R09 review, finding R08).
 *
 * `progressOf` collapses the internal lifecycle to the three things a client is told, and the
 * one trap is that `client_action_required` is an *audience*, not a state, and it is not
 * cleared when the work finishes. A completed item that still carries it must read as `done`,
 * never as `waiting_on_you` — the portal must not ask a client to act on finished work. This
 * pins every state/audience combination the portal can produce.
 *
 * The real service reads these rows against a live server in
 * `apps/api/test/client-002-portal.db.test.ts`; here we prove the pure mapping.
 */

const rowWith = (state: string, audience: WorkItemRow['audience']): WorkItemRow =>
  ({ state, audience }) as unknown as WorkItemRow;

// The audiences a client row can ever carry — `internal` is filtered out in the query.
const CLIENT_AUDIENCES: readonly WorkItemRow['audience'][] = [
  'client_visible',
  'client_action_required',
];

const TERMINAL_STATES = ['done', 'archived'] as const;
const OPEN_STATES = ['backlog', 'ready', 'in_progress', 'blocked', 'internal_review'] as const;

describe('progressOf', () => {
  it('reads a terminal state as done regardless of the action audience', () => {
    for (const state of TERMINAL_STATES) {
      for (const audience of CLIENT_AUDIENCES) {
        expect(progressOf(rowWith(state, audience)), `${state}/${audience}`).toBe('done');
      }
    }
  });

  it('never leaves finished work awaiting the client (the R08 regression)', () => {
    // A done item that still carries the action audience is the exact combination the review
    // reproduced returning `waiting_on_you`. Terminal state must win.
    expect(progressOf(rowWith('done', 'client_action_required'))).toBe('done');
    expect(progressOf(rowWith('archived', 'client_action_required'))).toBe('done');
  });

  it('promotes only an open action-required item to waiting_on_you', () => {
    for (const state of OPEN_STATES) {
      expect(progressOf(rowWith(state, 'client_action_required')), state).toBe('waiting_on_you');
    }
  });

  it('reads every other open state as in_progress', () => {
    for (const state of OPEN_STATES) {
      expect(progressOf(rowWith(state, 'client_visible')), state).toBe('in_progress');
    }
  });
});

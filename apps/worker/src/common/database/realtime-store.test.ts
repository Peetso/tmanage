import { describe, expect, it } from 'vitest';
import { checkConversationSubscription } from './realtime-store.js';
import type { WorkerTransaction } from './worker-database.js';

/**
 * The project gate added for slice x33 (REVIEW R04 "align the initial check with the HTTP
 * project's access rules as well"). A channel-membership row is not on its own a licence to
 * the channel's project; the subscribe check must also see a current project relation, the
 * same one `authorize()` enforces over HTTP. These pin the JS gate without a database; the
 * SQL that computes `may_reach_project` is exercised against real rows by
 * `apps/api/test/rt-001-realtime.db.test.ts`.
 */

interface FakeRow {
  readonly role: string;
  readonly next_sequence_no: number;
  readonly is_member: number;
  readonly may_reach_project: number;
  readonly has_org_wide_scope: number;
}

function txReturning(row: FakeRow): WorkerTransaction {
  return {
    query: async <T>(): Promise<T> => [row] as unknown as T,
  };
}

const INPUT = { organizationId: 'org-1', userId: 'user-1', conversationId: 'conv-1' } as const;

describe('checkConversationSubscription — project gate', () => {
  it('refuses a channel whose project the subscriber can no longer reach', async () => {
    const tx = txReturning({
      role: 'member',
      next_sequence_no: 8,
      is_member: 1,
      may_reach_project: 0,
      has_org_wide_scope: 0,
    });

    const verdict = await checkConversationSubscription(tx, INPUT);

    expect(verdict.allowed).toBe(false);
  });

  it('allows a member who reaches the project and holds the channel row', async () => {
    const tx = txReturning({
      role: 'member',
      next_sequence_no: 8,
      is_member: 1,
      may_reach_project: 1,
      has_org_wide_scope: 0,
    });

    const verdict = await checkConversationSubscription(tx, INPUT);

    expect(verdict).toEqual({ allowed: true, cursor: 7 });
  });
});

/**
 * The channel-membership half of the alignment (x41, review-x33 finding I1). Over HTTP
 * `ConversationsService.mayReach` returns true for an org-wide principal that passes the
 * project gate *without* a `conversation_memberships` row; a plain member still needs one.
 * The subscribe check must answer the same way, so the two paths agree on who may read a
 * channel. These pin the JS gate without a database; the SQL that reads `has_org_wide_scope`
 * against real rows is exercised by `apps/api/test/rt-001-realtime.db.test.ts`.
 */
describe('checkConversationSubscription — org-wide channel-membership exemption', () => {
  it('allows an org-wide principal that reaches the project but holds no channel row', async () => {
    const tx = txReturning({
      role: 'owner',
      next_sequence_no: 8,
      is_member: 0,
      may_reach_project: 1,
      has_org_wide_scope: 1,
    });

    const verdict = await checkConversationSubscription(tx, INPUT);

    expect(verdict).toEqual({ allowed: true, cursor: 7 });
  });

  it('refuses a non-org-wide member that reaches the project but holds no channel row', async () => {
    const tx = txReturning({
      role: 'member',
      next_sequence_no: 8,
      is_member: 0,
      may_reach_project: 1,
      has_org_wide_scope: 0,
    });

    const verdict = await checkConversationSubscription(tx, INPUT);

    expect(verdict.allowed).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { checkConversationSubscription } from './realtime-store.js';
import type { WorkerTransaction } from './worker-database.js';

/**
 * The project gate added for slice x33 (REVIEW R04 "align the initial check with the HTTP
 * project's access rules as well"). A channel-membership row is not on its own a licence to
 * the channel's project; the subscribe check must also see a current project relation, the
 * same one `authorize()` enforces over HTTP. These pin the denied path without a database —
 * the row-computed `may_reach_project` flag stands in for the SQL the db suite exercises.
 */

interface FakeRow {
  readonly role: string;
  readonly next_sequence_no: number;
  readonly is_member: number;
  readonly may_reach_project: number;
}

function txReturning(row: FakeRow, sink: { sql?: string }): WorkerTransaction {
  return {
    query: async <T>(sql: string): Promise<T> => {
      sink.sql = sql;
      return [row] as unknown as T;
    },
  };
}

const INPUT = { organizationId: 'org-1', userId: 'user-1', conversationId: 'conv-1' } as const;

describe('checkConversationSubscription — project gate', () => {
  it('refuses a channel whose project the subscriber can no longer reach', async () => {
    const sink: { sql?: string } = {};
    const tx = txReturning(
      { role: 'member', next_sequence_no: 8, is_member: 1, may_reach_project: 0 },
      sink,
    );

    const verdict = await checkConversationSubscription(tx, INPUT);

    expect(verdict.allowed).toBe(false);
    // The gate must be computed in SQL, so dropping it cannot pass silently.
    expect(sink.sql).toContain('project_memberships');
    expect(sink.sql).toContain('has_org_wide_scope');
  });

  it('allows a member who reaches the project and holds the channel row', async () => {
    const sink: { sql?: string } = {};
    const tx = txReturning(
      { role: 'member', next_sequence_no: 8, is_member: 1, may_reach_project: 1 },
      sink,
    );

    const verdict = await checkConversationSubscription(tx, INPUT);

    expect(verdict).toEqual({ allowed: true, cursor: 7 });
  });
});

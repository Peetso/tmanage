import { describe, expect, it } from 'vitest';
import type { WorkerTransaction } from '../common/database/worker-database.js';
import type { ClaimedOutboxEvent } from '../common/database/outbox-store.js';
import { COLLABORATION_PLANNERS, planWorkItemMentionNotices } from './collaboration-notices.js';

/**
 * 53-11 — who a work-item comment's @mentions tell, over a fake transaction answering each read by
 * its SQL (the `collaboration-notices.test.ts` harness). Access is re-checked at delivery: somebody
 * no longer on the project is skipped even though the API listed them.
 */

const ORG = 'org-1';

function event(payload: Record<string, unknown>): ClaimedOutboxEvent {
  return {
    id: 'event-1',
    organizationId: ORG,
    type: 'work_item.comment_created.v1',
    schemaVersion: 1,
    aggregateType: 'work_item',
    aggregateId: 'wi-1',
    payload,
    correlationId: null,
    occurredAt: new Date('2026-11-08T00:00:00.000Z'),
    attempts: 1,
  } as ClaimedOutboxEvent;
}

function fakeTx(answer: (sql: string, params: readonly unknown[]) => unknown): WorkerTransaction {
  return {
    async query(sql: string, params: readonly unknown[] = []): Promise<unknown> {
      return answer(sql, params) ?? [];
    },
  } as WorkerTransaction;
}

const ON_PROJECT = new Set(['lina']);

const tx = fakeTx((sql, params) => {
  if (sql.includes('FROM work_items')) {
    return [
      { title: 'Final export', project_id: 'proj-1', owner_user_id: null, audience: 'internal' },
    ];
  }
  if (sql.includes('FROM memberships m')) {
    const userId = String(params[2]);
    return [
      {
        id: `membership-${userId}`,
        role: 'member',
        has_org_wide_scope: 0,
        on_project: ON_PROJECT.has(userId) ? 1 : 0,
      },
    ];
  }
  return [];
});

const payload = {
  workItemId: 'wi-1',
  commentId: 'c-1',
  projectId: 'proj-1',
  authorUserId: 'omar',
};

describe('planWorkItemMentionNotices (53-11)', () => {
  it('tells a mentioned person who can see the item, as a mention, never the author', async () => {
    const notices = await planWorkItemMentionNotices(
      event({ ...payload, mentionedUserIds: ['lina', 'gone', 'omar'] }),
      tx,
      null,
    );
    expect(notices.map((notice) => notice.recipientUserId)).toEqual(['lina']);
    expect(notices[0]).toMatchObject({
      optOutKind: 'mention',
      mailKind: 'mention',
      inApp: {
        type: 'work_item.mentioned.v1',
        objectType: 'work_item',
        objectId: 'wi-1',
        dedupeKey: 'work_item.mentioned:c-1:lina',
      },
    });
  });

  it('tells nobody without mentions, and is registered for the event', async () => {
    expect(
      await planWorkItemMentionNotices(event({ ...payload, mentionedUserIds: [] }), tx, null),
    ).toEqual([]);
    expect(COLLABORATION_PLANNERS['work_item.comment_created.v1']).toBe(planWorkItemMentionNotices);
  });
});

import { describe, expect, it } from 'vitest';
import { INTERNAL_ROLES } from '@tmanage/domain';
import { expectedCeilingGrants } from '@tmanage/test-kit';
import type { WorkerTransaction } from '../common/database/worker-database.js';
import type { ClaimedOutboxEvent } from '../common/database/outbox-store.js';
import { mayBeTold, planClientActionNotices, planMentionNotices } from './collaboration-notices.js';
import { automationRunsConsumer, notRunReason } from './automation-runs.js';
import { CollaborationMailer } from '../notifications/collaboration-mailer.js';

/**
 * CQ-12 — the recipient rules of the collaboration notices and the automation runner, over a fake
 * transaction that answers each statement by what it reads. The real SQL against a real server is
 * the database suites' business; this proves who is told, and that a rule now fires.
 */

const ORG = 'org-1';

function event(type: string, payload: Record<string, unknown>): ClaimedOutboxEvent {
  return {
    id: 'event-1',
    organizationId: ORG,
    type,
    schemaVersion: 1,
    aggregateType: 'x',
    aggregateId: 'x',
    payload,
    correlationId: null,
    occurredAt: new Date('2026-10-19T00:00:00.000Z'),
    attempts: 1,
  } as ClaimedOutboxEvent;
}

/** A fake transaction: each read answered by a matcher on its SQL; every statement recorded. */
function fakeTx(answer: (sql: string, params: readonly unknown[]) => unknown): {
  tx: WorkerTransaction;
  writes: { sql: string; params: readonly unknown[] }[];
} {
  const writes: { sql: string; params: readonly unknown[] }[] = [];
  const tx = {
    async query(sql: string, params: readonly unknown[] = []): Promise<unknown> {
      if (/^\s*INSERT/u.test(sql)) {
        writes.push({ sql, params });
        return { affectedRows: 1 };
      }
      return answer(sql, params) ?? [];
    },
  } as WorkerTransaction;
  return { tx, writes };
}

const member = (userId: string, onProject: boolean) => ({
  id: `membership-${userId}`,
  role: 'member',
  has_org_wide_scope: 0,
  on_project: onProject ? 1 : 0,
});

describe('mayBeTold', () => {
  it('agrees with the permission matrix for every internal role, and needs the project', () => {
    for (const role of INTERNAL_ROLES) {
      const reach = { membershipId: 'm', role, hasOrgWideScope: false, onProject: true };
      expect(mayBeTold(reach, 'conversation.read'), role).toBe(
        expectedCeilingGrants(role, 'conversation.read'),
      );
      expect(mayBeTold({ ...reach, onProject: false }, 'conversation.read'), role).toBe(false);
    }
    expect(mayBeTold(null, 'work.read')).toBe(false);
  });
});

describe('planMentionNotices (COL-05)', () => {
  it('tells a mentioned channel member, and not someone outside the channel or the author', async () => {
    const { tx } = fakeTx((sql, params) => {
      if (sql.includes('FROM memberships m')) return [member(String(params[2]), true)];
      if (sql.includes('FROM conversation_memberships')) {
        return [{ present: params[2] === 'mona' ? 1 : 0 }];
      }
      return [];
    });
    const notices = await planMentionNotices(
      event('message.created.v1', {
        messageId: 'msg-1',
        conversationId: 'conv-1',
        projectId: 'proj-1',
        parentMessageId: null,
        authorUserId: 'sara',
        mentionedUserIds: ['mona', 'outsider', 'sara'],
      }),
      tx,
      null,
    );
    expect(notices.map((notice) => notice.recipientUserId)).toEqual(['mona']);
    expect(notices[0]).toMatchObject({
      optOutKind: 'mention',
      inApp: { objectType: 'conversation', objectId: 'conv-1' },
    });
  });
});

describe('planClientActionNotices (APR-03)', () => {
  it('emails client people who may decide, never a viewer', async () => {
    const { tx } = fakeTx((sql) => {
      if (sql.includes('FROM work_items')) {
        return [
          {
            title: 'Homepage design',
            project_id: 'proj-1',
            owner_user_id: null,
            audience: 'client_action_required',
          },
        ];
      }
      if (sql.includes('FROM client_memberships')) {
        return [
          { user_id: 'rami', role: 'client_reviewer' },
          { user_id: 'vera', role: 'client_viewer' },
        ];
      }
      return [];
    });
    const transport = { send: () => Promise.resolve('sent' as const) };
    const notices = await planClientActionNotices(
      event('work_item.client_action_requested.v1', { workItemId: 'wi-1', projectId: 'proj-1' }),
      tx,
      new CollaborationMailer(transport, 'https://app.example'),
    );
    expect(notices.map((notice) => notice.recipientUserId)).toEqual(['rami']);
    expect(notices[0]?.inApp).toBeNull();
  });
});

describe('automation runs (AUT-01)', () => {
  it('only notify_owner has an executor; the rest say why nothing was done', () => {
    expect(notRunReason('notify_owner')).toBeNull();
    expect(notRunReason('post_message')).toBe('action_not_available_yet');
    expect(notRunReason('send_email_digest')).toBe('external_action_not_supported_in_app');
  });

  it('a live "request submitted → notify owner" rule fires: the manager is told and a run is recorded', async () => {
    const { tx, writes } = fakeTx((sql, params) => {
      if (sql.includes('FROM workflow_templates')) {
        return [
          {
            id: 'rule-1',
            name: 'Notify owner',
            trigger_kind: 'request_submitted',
            action_kind: 'notify_owner',
          },
        ];
      }
      if (sql.includes('FROM project_memberships pm') && sql.includes('role IN')) {
        return [{ user_id: 'mona' }];
      }
      if (sql.includes('FROM projects')) return [{ owner_user_id: null }];
      if (sql.includes('FROM memberships m')) return [member(String(params[2]), true)];
      return [];
    });
    await automationRunsConsumer(
      event('client_request.submitted.v1', {
        requestId: 'req-1',
        projectId: 'proj-1',
        clientOrganizationId: 'acme',
        state: 'submitted',
      }),
      tx,
      { afterCommit: () => undefined },
    );
    const notice = writes.find((write) => write.sql.includes('INTO notifications'));
    expect(notice?.params).toEqual(expect.arrayContaining(['mona', 'client_request', 'req-1']));
    const run = writes.find((write) => write.sql.includes('INTO workflow_runs'));
    expect(run?.params).toEqual(expect.arrayContaining(['rule-1', 'succeeded']));
  });
});

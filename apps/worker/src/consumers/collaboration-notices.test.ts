import { describe, expect, it } from 'vitest';
import { INTERNAL_ROLES } from '@tmanage/domain';
import { expectedCeilingGrants } from '@tmanage/test-kit';
import type { WorkerTransaction } from '../common/database/worker-database.js';
import type { ClaimedOutboxEvent } from '../common/database/outbox-store.js';
import {
  mayBeTold,
  planApprovalDecidedNotices,
  planApprovalRequestedNotices,
  planClientActionNotices,
  planMentionNotices,
  planRequestMessageNotices,
} from './collaboration-notices.js';
import { automationRunsConsumer, notRunReason } from './automation-runs.js';
import {
  CollaborationMailer,
  composeCollaborationEmail,
  isArabicLocale,
} from '../notifications/collaboration-mailer.js';

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

  it('C25: an item narrowed to one client company never emails another company’s people', async () => {
    const { tx } = fakeTx((sql) => {
      if (sql.includes('FROM work_items')) {
        return [
          {
            title: 'Logo',
            project_id: 'proj-1',
            owner_user_id: null,
            audience: 'client_action_required',
          },
        ];
      }
      if (sql.includes('FROM client_memberships')) {
        return [
          { user_id: 'rami', role: 'client_reviewer', client_organization_id: 'atlas' },
          { user_id: 'noor', role: 'client_reviewer', client_organization_id: 'northwind' },
        ];
      }
      if (sql.includes('FROM work_item_client_audience'))
        return [{ client_organization_id: 'atlas' }];
      return [];
    });
    const notices = await planClientActionNotices(
      event('work_item.client_action_requested.v1', { workItemId: 'wi-1', projectId: 'proj-1' }),
      tx,
      new CollaborationMailer(
        { send: () => Promise.resolve('sent' as const) },
        'https://app.example',
      ),
    );
    expect(notices.map((notice) => notice.recipientUserId)).toEqual(['rami']);
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

describe('planApprovalRequestedNotices (NT1)', () => {
  it('gives the picked client deciders an in-app row even with no mail transport', async () => {
    const { tx } = fakeTx((sql) => {
      if (sql.includes('FROM client_memberships')) {
        return [
          { user_id: 'rami', role: 'client_reviewer' },
          { user_id: 'vera', role: 'client_viewer' },
          { user_id: 'omar', role: 'client_reviewer' },
        ];
      }
      return [];
    });
    const notices = await planApprovalRequestedNotices(
      event('approval.requested.v1', {
        approvalId: 'apr-1',
        deliverableId: 'del-1',
        deliverableVersionId: 'ver-1',
        projectId: 'proj-1',
        reviewerUserIds: ['rami', 'vera'],
      }),
      tx,
      null,
    );
    expect(notices.map((notice) => notice.recipientUserId)).toEqual(['rami']);
    expect(notices[0]).toMatchObject({
      mailKind: 'approval_requested',
      inApp: {
        objectType: 'deliverable_version',
        objectId: 'ver-1',
        dedupeKey: 'approval.requested:apr-1',
      },
    });
  });
});

describe('planRequestMessageNotices (NT1)', () => {
  const payload = {
    requestId: 'req-1',
    messageId: 'rm-1',
    projectId: 'proj-1',
    clientOrganizationId: 'acme',
    authorMembershipId: 'cm-1',
  };
  const answer = (sql: string, params: readonly unknown[]): unknown => {
    if (sql.includes('FROM client_requests')) {
      return [{ title: 'New logo', submitted_by_user_id: 'rami' }];
    }
    if (sql.includes('AS permitted')) return [{ permitted: 1 }];
    if (sql.includes('FROM memberships m') && params.length === 2) {
      return [
        { user_id: 'mona', role: 'manager', has_org_wide_scope: 0, on_project: 1 },
        { user_id: 'off', role: 'manager', has_org_wide_scope: 0, on_project: 0 },
        { user_id: 'sam', role: 'member', has_org_wide_scope: 0, on_project: 1 },
      ];
    }
    if (sql.includes('FROM memberships m')) {
      const userId = String(params[2]);
      return [
        { ...member(userId, userId !== 'off'), role: userId === 'sam' ? 'member' : 'manager' },
      ];
    }
    return [];
  };

  it('a client message tells the team on the project; a team reply tells the submitter; an internal note tells nobody', async () => {
    const { tx } = fakeTx(answer);
    const fromClient = await planRequestMessageNotices(
      event('client_request.message_posted.v1', {
        ...payload,
        authorKind: 'client',
        clientVisible: true,
      }),
      tx,
      null,
    );
    expect(fromClient.map((notice) => notice.recipientUserId)).toEqual(['mona']);
    expect(fromClient[0]).toMatchObject({
      optOutKind: 'message',
      inApp: { objectType: 'client_request', dedupeKey: 'client_request.message:rm-1' },
    });

    const fromTeam = await planRequestMessageNotices(
      event('client_request.message_posted.v1', {
        ...payload,
        authorKind: 'internal',
        clientVisible: true,
      }),
      tx,
      null,
    );
    expect(fromTeam.map((notice) => notice.recipientUserId)).toEqual(['rami']);

    const note = await planRequestMessageNotices(
      event('client_request.message_posted.v1', {
        ...payload,
        authorKind: 'internal',
        clientVisible: false,
      }),
      tx,
      null,
    );
    expect(note).toEqual([]);
  });
});

describe('composeCollaborationEmail locale (NT1)', () => {
  it('writes the review and message emails in Arabic for an ar locale, English otherwise', () => {
    const facts = {
      recipientEmail: 'rami@example.com',
      recipientName: 'Rami',
      organizationName: 'Studio',
      subjectTitle: 'Website',
      link: 'https://app.example/s/portal/deliverables/ver-1',
    };
    const arabic = composeCollaborationEmail('approval_requested', { ...facts, locale: 'ar-EG' });
    expect(arabic.subject).toContain('مطلوب اعتمادك');
    expect(arabic.text).toContain(facts.link);
    const english = composeCollaborationEmail('approval_requested', { ...facts, locale: 'en' });
    expect(english.subject).toBe('Your approval is needed: Website');
    expect(isArabicLocale('arabic')).toBe(false);
  });
});

describe('planApprovalDecidedNotices (Q3)', () => {
  const roles: Record<string, { role: string; onProject: boolean }> = {
    gina: { role: 'guest', onProject: true }, // the sender: told although a guest
    gus: { role: 'guest', onProject: true }, // cannot create deliverables: not told
    mona: { role: 'manager', onProject: true },
    off: { role: 'manager', onProject: false }, // cannot reach the project
    dina: { role: 'manager', onProject: true }, // decided herself: not told
  };
  const answer = (sql: string, params: readonly unknown[]): unknown => {
    if (sql.includes('FROM memberships m') && params.length === 2) {
      return Object.entries(roles).map(([userId, r]) => ({
        user_id: userId,
        role: r.role,
        has_org_wide_scope: 0,
        on_project: r.onProject ? 1 : 0,
      }));
    }
    if (sql.includes('FROM memberships m')) {
      const r = roles[String(params[2])];
      return r === undefined ? [] : [{ ...member(String(params[2]), r.onProject), role: r.role }];
    }
    return [];
  };
  const payload = {
    approvalId: 'appr-1',
    deliverableId: 'del-1',
    deliverableVersionId: 'ver-1',
    projectId: 'proj-1',
    decision: 'approved',
    decidedByUserId: 'dina',
    requestedByUserId: 'gina',
  };

  it('tells the sender and the deliverable makers on the project, never the decider or a client', async () => {
    const { tx } = fakeTx(answer);
    const notices = await planApprovalDecidedNotices(
      event('approval.decided.v1', payload),
      tx,
      null,
    );
    expect(notices.map((notice) => notice.recipientUserId)).toEqual(['gina', 'mona']);
    expect(notices[0]).toMatchObject({
      optOutKind: 'message',
      membershipId: 'membership-gina',
      mailKind: 'approval_decided',
      inApp: {
        type: 'approval.decided.v1',
        objectType: 'deliverable_version',
        objectId: 'ver-1',
        dedupeKey: 'approval.decided:appr-1',
      },
    });
    // A client decider has no internal membership: the requester alone is never a client.
    const fromClient = await planApprovalDecidedNotices(
      event('approval.decided.v1', { ...payload, decidedByUserId: 'youssef' }),
      tx,
      null,
    );
    expect(fromClient.map((notice) => notice.recipientUserId)).toEqual(['gina', 'mona', 'dina']);
  });

  it('emails in English or Arabic by locale, links the deliverable, and names the decision', () => {
    const facts = {
      recipientEmail: 'mona@example.com',
      recipientName: 'Mona',
      organizationName: 'Studio',
      actorName: 'Youssef',
      subjectTitle: 'Website',
      projectName: 'Website',
      link: 'https://app.example/s/projects/proj-1/deliverables/del-1',
    };
    const approved = composeCollaborationEmail('approval_decided', {
      ...facts,
      decision: 'approved',
    });
    expect(approved.subject).toBe('Youssef approved a deliverable in Website');
    expect(approved.text).toContain(facts.link);
    const changes = composeCollaborationEmail('approval_decided', {
      ...facts,
      decision: 'changes_requested',
      locale: 'ar',
    });
    expect(changes.subject).toContain('طلب Youssef تعديلات');
    expect(changes.text).toContain(facts.link);
  });
});

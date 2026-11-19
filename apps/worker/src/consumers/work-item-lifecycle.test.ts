import { describe, expect, it } from 'vitest';
import { clientRequestStateMachine } from '@tmanage/domain';
import type { MailDelivery, Mailer } from '@tmanage/mail';
import { WORKER_OUTBOX_HANDLERS, createWorkerOutboxHandlers } from './registry.js';
import { ClientRequestMailer } from '../notifications/client-request-mailer.js';
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
      'approval.decided.v1',
      'approval.requested.v1',
      'client_request.message_posted.v1',
      'client_request.submitted.v1',
      'client_request.transitioned.v1',
      'direct_message.created.v1',
      'document.comment_created.v1',
      'document.published.v1',
      'meeting.attendee_invited.v1',
      'meeting.attendee_responded.v1',
      'meeting.changed.v1',
      'meeting.scheduled.v1',
      'message.created.v1',
      'project.member_added.v1',
      // R4 slice 12 — the proofing viewer's notices.
      'review.comment_added.v1',
      'review.decision_recorded.v1',
      'review.thread_created.v1',
      'review.thread_resolved.v1',
      'storage_connection.root_at_risk.v1',
      'usage.threshold_reached.v1',
      'work_item.blocked.v1',
      'work_item.client_action_requested.v1',
      'work_item.comment_created.v1',
      'work_item.created.v1',
      'work_item.people_assigned.v1',
      'work_item.updated.v1',
      // 62-27 — the responsible manager's notice for a raised work signal.
      'work_signal.raised.v1',
    ]);
  });

  it('routes the quiet-hours resume row to a dedicated handler, not the notification consumer', () => {
    // INBOX-001: a deferred email resumes on its own internal event type. That type must map to a
    // handler of its own — never to `both(notification, mail)` under a `client_request.*` key — so
    // the notification consumer (and any future consumer of the real type) never sees a resume row
    // and cannot double-fire on it. On the pre-fix code the resume row reused the original type, so
    // this key did not exist and the notification consumer re-ran on it; this pins the fix.
    const transport: Mailer = { send: (): Promise<MailDelivery> => Promise.resolve('sent') };
    const handlers = createWorkerOutboxHandlers({
      clientRequestMailer: new ClientRequestMailer(transport, 'https://app.example'),
    });
    const resume = handlers['notification.quiet_hours_resume.v1'];
    expect(typeof resume).toBe('function');
    expect(resume).not.toBe(handlers['client_request.submitted.v1']);
    expect(resume).not.toBe(handlers['client_request.transitioned.v1']);
  });
});

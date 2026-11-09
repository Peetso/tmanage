import { workItemLifecycleConsumer } from './work-item-lifecycle.js';
import {
  clientRequestSubmittedConsumer,
  clientRequestTransitionedConsumer,
} from './client-request-notifications.js';
import { workItemBlockedConsumer } from './work-blocked-notification.js';
import { usageThresholdReachedConsumer } from './usage-threshold-notice.js';
import {
  createUsageThresholdMail,
  createUsageThresholdMailResume,
} from './usage-threshold-mail.js';
import {
  createClientRequestSubmittedMail,
  createClientRequestTransitionedMail,
  createQuietHoursMailResume,
} from './client-request-mail.js';
import { QUIET_HOURS_MAIL_RESUME_TYPE } from '../common/database/notifications-store.js';
import { createCredentialChangeMail } from './credential-change-mail.js';
import {
  COLLABORATION_PLANNERS,
  createCollaborationMailResume,
  createCollaborationNotices,
  planApprovalDecidedNotices,
  planApprovalRequestedNotices,
  planClientActionNotices,
  planPeopleAssignedNotices,
  planWorkItemMentionNotices,
  planSupervisorDoneNotices,
  planCommentNotices,
  planMeetingChangedNotices,
  planMeetingInviteNotices,
  planMeetingResponseNotices,
  planMentionNotices,
  planProjectAddedNotices,
  planRequestMessageNotices,
} from './collaboration-notices.js';
import { automationRunsConsumer } from './automation-runs.js';
import { withWebhookStaging } from './webhook-deliveries.js';
import {
  planReviewCommentNotices,
  planReviewDecisionNotices,
  planReviewResolvedNotices,
  REVIEW_PLANNERS,
} from './review-notices.js';
import {
  directConversationMessageNoticesConsumer,
  directMessageNoticesConsumer,
} from './direct-message-notices.js';
import type { CollaborationMailer } from '../notifications/collaboration-mailer.js';
import type { ClientRequestMailer } from '../notifications/client-request-mailer.js';
import type { CredentialChangeMailer } from '../notifications/credential-change-mailer.js';
import type { UsageThresholdMailer } from '../notifications/usage-threshold-mailer.js';
import type { PrivacyMailer } from '../notifications/privacy-mailer.js';
import { createPrivacyDeletionChangedMail, createPrivacyExportReadyMail } from './privacy-mail.js';
import {
  CREDENTIAL_CHANGE_NOTICE_TYPE,
  type ClaimedCredentialNotice,
} from '../common/database/notice-store.js';
import type { OutboxHandler, OutboxHandlers, QueueHandlers } from '../outbox/dispatcher.js';

/**
 * The registry `main.ts` runs, keyed by the type each consumer answers to. A file of its own
 * so consumers never import each other: each answers to its event, and this is the one place
 * the set is visible whole.
 *
 * ## Why this became a function
 *
 * It was a `const`, which was right while every consumer needed nothing but a transaction.
 * Mail needs a transport, and a transport is chosen by configuration at boot — so the set is
 * now built from its dependencies rather than declared. A caller with nothing to inject gets
 * exactly the previous set by passing nothing.
 *
 * ## Two consumers, one event type
 *
 * The dispatcher gives a type one handler. `client_request.submitted.v1` and
 * `client_request.transitioned.v1` now have two things to do — write the in-app notification,
 * and stage an email — so {@link both} runs them in sequence inside the event's single
 * savepoint. Sequence, not parallel: they share a transaction, and two statements racing on
 * one connection is a driver error, not concurrency. Notification first, deliberately: it is
 * the canonical channel, and if the mail half throws, the whole event rolls back and is
 * redelivered, where the notification's dedupe key absorbs the repeat.
 *
 * ## The quiet-hours resume is its own type, not a marked re-run
 *
 * INBOX-001 defers an interrupting email past a recipient's quiet window by re-enqueuing it as a
 * dedicated {@link QUIET_HOURS_MAIL_RESUME_TYPE} row. That type is registered here to the resume
 * handler **alone** — never to `both` — so the notification consumer, and any future
 * `client_request.*` consumer, cannot re-fire on a resume row. Reusing the original type with a
 * payload marker would have made no-double-delivery depend on every such consumer being
 * marker-aware or idempotent; a separate type makes it structural.
 */

/** Runs two handlers over one event, in order, sharing its transaction and its effects. */
export function both(first: OutboxHandler, second: OutboxHandler): OutboxHandler {
  return async (event, tx, effects) => {
    await first(event, tx, effects);
    await second(event, tx, effects);
  };
}

export interface WorkerConsumerDependencies {
  /** Absent, or present-but-disabled, means the client-request mail half is not registered. */
  readonly clientRequestMailer?: ClientRequestMailer | undefined;
  /** Absent, or present-but-disabled, means the notice queue drains without sending — x31. */
  readonly credentialChangeMailer?: CredentialChangeMailer | undefined;
  /** Absent, or present-but-disabled, means the usage-threshold mail half is not registered. */
  readonly usageThresholdMailer?: UsageThresholdMailer | undefined;
  /**
   * CQ-12. Absent or disabled, the collaboration notices still write their inbox rows and only
   * the email half (and the email-only client-action notice) is skipped.
   */
  readonly collaborationMailer?: CollaborationMailer | undefined;
  /** H3. Absent or disabled, the two data-rights events have no consumer (published, no mail). */
  readonly privacyMailer?: PrivacyMailer | undefined;
}

export function createWorkerOutboxHandlers(
  dependencies: WorkerConsumerDependencies = {},
): OutboxHandlers {
  const mailer = dependencies.clientRequestMailer;
  // `enabled` is false when no transport was configured. Composing a handler that would
  // return immediately every time is harmless but says something untrue about the registry.
  const mails = mailer !== undefined && mailer.enabled ? mailer : null;

  const usageMailer = dependencies.usageThresholdMailer;
  const usageMails = usageMailer !== undefined && usageMailer.enabled ? usageMailer : null;

  // The quiet-hours resume type takes one handler, but more than one interrupting producer can
  // defer onto it (client-request and usage). Each resume handler no-ops on a row that is not its
  // originalType, so composing them with `both` is safe: the row is decoded by each and acted on
  // by exactly one. Registered only when at least one deferring producer is wired.
  const collaborationMailer = dependencies.collaborationMailer;
  const collaborationMails =
    collaborationMailer !== undefined && collaborationMailer.enabled ? collaborationMailer : null;

  const resumeHandlers: OutboxHandler[] = [];
  if (mails !== null) resumeHandlers.push(createQuietHoursMailResume(mails));
  if (usageMails !== null) resumeHandlers.push(createUsageThresholdMailResume(usageMails));
  if (collaborationMails !== null) {
    // R4 slice 12: a deferred review email re-plans through the review planners too.
    resumeHandlers.push(
      createCollaborationMailResume(collaborationMails, {
        ...COLLABORATION_PLANNERS,
        ...REVIEW_PLANNERS,
      }),
    );
  }
  const resumeHandler = resumeHandlers.reduce<OutboxHandler | null>(
    (acc, handler) => (acc === null ? handler : both(acc, handler)),
    null,
  );

  const submitted =
    mails === null
      ? clientRequestSubmittedConsumer
      : both(clientRequestSubmittedConsumer, createClientRequestSubmittedMail(mails));

  // R13-s2: every type a webhook kind fires on also stages its pending webhook attempts, after the
  // event's own consumers, in the same savepoint (`webhook-deliveries.ts`; the sweep delivers).
  // R15-c Slack / Teams channel notices (`channel-notices.ts`) are no longer staged: Slack and
  // Teams were removed on 2026-11-10. Stored channel links stay in their table, untouched.
  return withWebhookStaging({
    // CQ-12 (AUT-01): every trigger event also runs the organization's enabled rules for it,
    // after the event's own consumers, in the same savepoint.
    // C26/C27: a task sent for review tells its supervisors it waits for their approval (in-app
    // and email).
    'work_item.updated.v1': both(
      both(workItemLifecycleConsumer, automationRunsConsumer),
      createCollaborationNotices(planSupervisorDoneNotices, collaborationMails),
    ),
    // C26/C27: people newly made doers or supervisors of a task are told (in-app and email).
    'work_item.people_assigned.v1': createCollaborationNotices(
      planPeopleAssignedNotices,
      collaborationMails,
    ),
    // 53-11: people @mentioned in a work item's comment who can see the item are told.
    'work_item.comment_created.v1': createCollaborationNotices(
      planWorkItemMentionNotices,
      collaborationMails,
    ),
    'work_item.created.v1': automationRunsConsumer,
    'meeting.scheduled.v1': automationRunsConsumer,
    'document.published.v1': automationRunsConsumer,
    // NOTIF-001 — see `client-request-notifications.ts` for who is told what, and why.
    // The mail half is `client-request-mail.ts`; it sends after the batch commits.
    'client_request.submitted.v1': both(submitted, automationRunsConsumer),
    // CQ-12 (COL-05, APR-03) — see `collaboration-notices.ts`. `message.created.v1` is composed
    // with the realtime fan-out in `main.ts` when the socket server runs.
    // R7 slice 6: a message in a direct conversation also tells the other participant (in-app).
    'message.created.v1': both(
      createCollaborationNotices(planMentionNotices, collaborationMails),
      directConversationMessageNoticesConsumer,
    ),
    // BK3-left: a direct message tells the other participant (in-app). Composed with the DM
    // realtime fan-out in `main.ts` when the socket server runs.
    'direct_message.created.v1': directMessageNoticesConsumer,
    'document.comment_created.v1': createCollaborationNotices(
      planCommentNotices,
      collaborationMails,
    ),
    'meeting.attendee_invited.v1': createCollaborationNotices(
      planMeetingInviteNotices,
      collaborationMails,
    ),
    // BK5: a meeting's title/date/time changed — the attendees at that moment are told.
    'meeting.changed.v1': createCollaborationNotices(planMeetingChangedNotices, collaborationMails),
    // Fix 2026-11-09: an answer given in Google Calendar / Outlook — the organizer is told.
    'meeting.attendee_responded.v1': createCollaborationNotices(
      planMeetingResponseNotices,
      collaborationMails,
    ),
    'project.member_added.v1': createCollaborationNotices(
      planProjectAddedNotices,
      collaborationMails,
    ),
    'work_item.client_action_requested.v1': createCollaborationNotices(
      planClientActionNotices,
      collaborationMails,
    ),
    // 0211 (APR-01/02), NT1: a version sent for client approval — the picked client deciders get
    // an in-app row and a "please review" email.
    'approval.requested.v1': createCollaborationNotices(
      planApprovalRequestedNotices,
      collaborationMails,
    ),
    // Q3: the client (or a staff reviewer) decided — the sender and the project's deliverable
    // makers get an in-app row and an email that bypasses quiet hours (yes-critical).
    'approval.decided.v1': createCollaborationNotices(
      planApprovalDecidedNotices,
      collaborationMails,
    ),
    // 0212 (BG3), NT1: a message on a client request tells the other side — see the planner.
    'client_request.message_posted.v1': createCollaborationNotices(
      planRequestMessageNotices,
      collaborationMails,
    ),
    // R4 slice 12 — the proofing viewer: comments, mentions, resolved threads and decisions on a
    // file under review. See `review-notices.ts` for who is told; same delivery path as above.
    'review.thread_created.v1': createCollaborationNotices(
      planReviewCommentNotices,
      collaborationMails,
    ),
    'review.comment_added.v1': createCollaborationNotices(
      planReviewCommentNotices,
      collaborationMails,
    ),
    'review.thread_resolved.v1': createCollaborationNotices(
      planReviewResolvedNotices,
      collaborationMails,
    ),
    'review.decision_recorded.v1': createCollaborationNotices(
      planReviewDecisionNotices,
      collaborationMails,
    ),
    'client_request.transitioned.v1':
      mails === null
        ? clientRequestTransitionedConsumer
        : both(clientRequestTransitionedConsumer, createClientRequestTransitionedMail(mails)),
    // WORK-003 — the blocker's ask owner, and nobody else.
    'work_item.blocked.v1': workItemBlockedConsumer,
    // USAGE-001 — the org-wide owner/admin inbox notice (x68, slice 4b, unconditional), composed
    // with the mail half (slice 4c) when a transport is wired. Notice first, so a mail throw rolls
    // back an event whose notice is re-inserted idempotently on redelivery.
    'usage.threshold_reached.v1':
      usageMails === null
        ? usageThresholdReachedConsumer
        : both(usageThresholdReachedConsumer, createUsageThresholdMail(usageMails)),
    // INBOX-001 — a quiet-hours-deferred email resumes on its own internal type, handled only by
    // the resume path(s), never by the notification consumer. Registered only when at least one
    // interrupting producer that defers is wired, since only they produce a resume row.
    ...(resumeHandler === null ? {} : { [QUIET_HOURS_MAIL_RESUME_TYPE]: resumeHandler }),
    // H3 — the data-rights receipts: "your export is ready", "deletion scheduled / cancelled /
    // carried out". Mail only; registered when a transport is wired.
    ...(dependencies.privacyMailer === undefined || !dependencies.privacyMailer.enabled
      ? {}
      : {
          'privacy_export.ready.v1': createPrivacyExportReadyMail(dependencies.privacyMailer),
          'privacy_deletion.changed.v1': createPrivacyDeletionChangedMail(
            dependencies.privacyMailer,
          ),
        }),
  });
}

/**
 * The dependency-free set — every consumer that needs nothing but a transaction. What the
 * database suites run, and what `main.ts` falls back to with no mail transport configured.
 */
export const WORKER_OUTBOX_HANDLERS: OutboxHandlers = createWorkerOutboxHandlers();

/**
 * The notice queue's handlers — x31. One key, one consumer, for the reason
 * `notice-store.ts` gives: `credential_change_notices` has exactly one row shape, and
 * `action` picks a template rather than a consumer.
 *
 * With no transport, the set is **empty** rather than a handler that returns immediately.
 * That is not a cosmetic choice: an empty set makes every notice an item with no consumer,
 * which the dispatcher publishes and stamps — so a worker with no mail configured drains the
 * queue instead of growing an unbounded tail that would page an operator about a deployment
 * that is behaving exactly as configured.
 */
export function createWorkerNoticeHandlers(
  dependencies: WorkerConsumerDependencies = {},
): QueueHandlers<ClaimedCredentialNotice> {
  const mailer = dependencies.credentialChangeMailer;
  if (mailer === undefined || !mailer.enabled) return {};
  return { [CREDENTIAL_CHANGE_NOTICE_TYPE]: createCredentialChangeMail(mailer) };
}

/** The dependency-free notice set: drain and stamp, send nothing. */
export const WORKER_NOTICE_HANDLERS: QueueHandlers<ClaimedCredentialNotice> =
  createWorkerNoticeHandlers();

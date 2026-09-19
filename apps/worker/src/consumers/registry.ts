import { workItemLifecycleConsumer } from './work-item-lifecycle.js';
import {
  clientRequestSubmittedConsumer,
  clientRequestTransitionedConsumer,
} from './client-request-notifications.js';
import { workItemBlockedConsumer } from './work-blocked-notification.js';
import { usageThresholdReachedConsumer } from './usage-threshold-notice.js';
import {
  createClientRequestSubmittedMail,
  createClientRequestTransitionedMail,
  createQuietHoursMailResume,
} from './client-request-mail.js';
import { QUIET_HOURS_MAIL_RESUME_TYPE } from '../common/database/notifications-store.js';
import { createCredentialChangeMail } from './credential-change-mail.js';
import type { ClientRequestMailer } from '../notifications/client-request-mailer.js';
import type { CredentialChangeMailer } from '../notifications/credential-change-mailer.js';
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
}

export function createWorkerOutboxHandlers(
  dependencies: WorkerConsumerDependencies = {},
): OutboxHandlers {
  const mailer = dependencies.clientRequestMailer;
  // `enabled` is false when no transport was configured. Composing a handler that would
  // return immediately every time is harmless but says something untrue about the registry.
  const mails = mailer !== undefined && mailer.enabled ? mailer : null;

  return {
    'work_item.updated.v1': workItemLifecycleConsumer,
    // NOTIF-001 — see `client-request-notifications.ts` for who is told what, and why.
    // The mail half is `client-request-mail.ts`; it sends after the batch commits.
    'client_request.submitted.v1':
      mails === null
        ? clientRequestSubmittedConsumer
        : both(clientRequestSubmittedConsumer, createClientRequestSubmittedMail(mails)),
    'client_request.transitioned.v1':
      mails === null
        ? clientRequestTransitionedConsumer
        : both(clientRequestTransitionedConsumer, createClientRequestTransitionedMail(mails)),
    // WORK-003 — the blocker's ask owner, and nobody else.
    'work_item.blocked.v1': workItemBlockedConsumer,
    // USAGE-001 slice 4b — org-wide owner/admin inbox notice on a storage threshold crossing.
    // No mailer dependency: the mail half needs a new template and is a recorded follow-up.
    'usage.threshold_reached.v1': usageThresholdReachedConsumer,
    // INBOX-001 — a quiet-hours-deferred email resumes on its own internal type, handled only by
    // the resume path, never by the notification consumer. Registered only with a transport,
    // since a resume row can only be produced by the mail consumer, which only runs when enabled.
    ...(mails === null
      ? {}
      : { [QUIET_HOURS_MAIL_RESUME_TYPE]: createQuietHoursMailResume(mails) }),
  };
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

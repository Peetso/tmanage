import { workItemLifecycleConsumer } from './work-item-lifecycle.js';
import {
  clientRequestSubmittedConsumer,
  clientRequestTransitionedConsumer,
} from './client-request-notifications.js';
import { workItemBlockedConsumer } from './work-blocked-notification.js';
import {
  createClientRequestSubmittedMail,
  createClientRequestTransitionedMail,
} from './client-request-mail.js';
import type { ClientRequestMailer } from '../notifications/client-request-mailer.js';
import type { OutboxHandler, OutboxHandlers } from '../outbox/dispatcher.js';

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
  };
}

/**
 * The dependency-free set — every consumer that needs nothing but a transaction. What the
 * database suites run, and what `main.ts` falls back to with no mail transport configured.
 */
export const WORKER_OUTBOX_HANDLERS: OutboxHandlers = createWorkerOutboxHandlers();

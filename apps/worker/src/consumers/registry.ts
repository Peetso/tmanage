import { workItemLifecycleConsumer } from './work-item-lifecycle.js';
import {
  clientRequestSubmittedConsumer,
  clientRequestTransitionedConsumer,
} from './client-request-notifications.js';
import { workItemBlockedConsumer } from './work-blocked-notification.js';

/**
 * The registry `main.ts` runs, keyed by the type each consumer answers to. A file of its
 * own so consumers never import each other: each answers to its event, and this is the
 * one place the set is visible whole.
 */
export const WORKER_OUTBOX_HANDLERS = {
  'work_item.updated.v1': workItemLifecycleConsumer,
  // NOTIF-001 — see `client-request-notifications.ts` for who is told what, and why.
  'client_request.submitted.v1': clientRequestSubmittedConsumer,
  'client_request.transitioned.v1': clientRequestTransitionedConsumer,
  // WORK-003 — the blocker's ask owner, and nobody else.
  'work_item.blocked.v1': workItemBlockedConsumer,
} as const;

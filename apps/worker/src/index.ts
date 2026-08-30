/**
 * @tmanage/worker — PLAT-004's relay, importable as a library.
 *
 * `main.ts` is the process; this is the surface the API's database suite drives, so the
 * relay is proved against the same embedded server as everything else rather than against
 * a mock of itself.
 */

export { createWorkerDatabase } from './common/database/worker-database.js';
export type {
  WorkerDatabase,
  WorkerDatabaseOptions,
  WorkerTransaction,
} from './common/database/worker-database.js';

export {
  claimDueEvents,
  listParkedEvents,
  markPublished,
  recordFailure,
  withSavepoint,
} from './common/database/outbox-store.js';
export type {
  ClaimOptions,
  ClaimedOutboxEvent,
  ParkedOutboxEvent,
} from './common/database/outbox-store.js';

export { backoffDelayMs } from './outbox/backoff.js';
export { runOutboxBatch, runOutboxLoop } from './outbox/dispatcher.js';
export type {
  BatchReport,
  DispatcherOptions,
  EventFailure,
  LoopOptions,
  OutboxHandler,
  OutboxHandlers,
} from './outbox/dispatcher.js';

export { WORKER_OUTBOX_HANDLERS } from './consumers/registry.js';
export {
  requestTransitionFor,
  workItemLifecycleConsumer,
} from './consumers/work-item-lifecycle.js';
export {
  clientRequestSubmittedConsumer,
  clientRequestTransitionedConsumer,
  mayTriageClientRequests,
} from './consumers/client-request-notifications.js';
export { workItemBlockedConsumer } from './consumers/work-blocked-notification.js';
export type { InternalRecipientCandidate } from './common/database/notifications-store.js';

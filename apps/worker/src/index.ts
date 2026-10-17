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
  OutboxTransactionLostError,
  claimReservedEvents,
  isRecoverableBatchError,
  listParkedEvents,
  markPublished,
  readOutboxBacklog,
  recordFailure,
  releaseReservedAttempts,
  reserveDueEvents,
  withSavepoint,
} from './common/database/outbox-store.js';
export type {
  ClaimOptions,
  ClaimedOutboxEvent,
  OutboxBacklog,
  ParkedOutboxEvent,
} from './common/database/outbox-store.js';

// x31 — `credential_change_notices`, the second queue the same dispatcher drains.
export {
  CREDENTIAL_CHANGE_NOTICE_TYPE,
  CREDENTIAL_NOTICE_QUEUE,
  claimReservedNotices,
  findCredentialNoticeRecipient,
  listParkedNotices,
  markNoticePublished,
  readNoticeBacklog,
  recordNoticeFailure,
  releaseReservedNoticeAttempts,
  reserveDueNotices,
  unparkNotices,
} from './common/database/notice-store.js';
export type {
  ClaimedCredentialNotice,
  CredentialNoticeRecipient,
} from './common/database/notice-store.js';

export { backoffDelayMs } from './outbox/backoff.js';
// Is the relay draining? — the audit's CRITICAL-2, exported so the db suite can drive the
// same readings the `--status` command prints.
export {
  backlogIsStale,
  describeHealth,
  evaluateOutboxHealth,
  heartbeatTempPath,
  mergeBacklogs,
  onceIsUnhealthy,
  readHeartbeat,
  readHeartbeatState,
  writeHeartbeat,
} from './outbox/health.js';
export type {
  OutboxHealth,
  OutboxHealthInput,
  OutboxHealthReason,
  OutboxHealthThresholds,
} from './outbox/health.js';
export {
  OUTBOX_QUEUE,
  loopErrorDelayMs,
  runOutboxBatch,
  runOutboxLoop,
  runQueueBatch,
  runQueueLoop,
} from './outbox/dispatcher.js';
export type {
  BatchReport,
  DispatcherOptions,
  EffectFailure,
  EventFailure,
  LoopOptions,
  OutboxEffect,
  OutboxEffects,
  OutboxHandler,
  OutboxHandlers,
  ParkedQueueRow,
  QueueHandler,
  QueueHandlers,
  QueueItem,
  QueueStore,
} from './outbox/dispatcher.js';

export {
  WORKER_NOTICE_HANDLERS,
  WORKER_OUTBOX_HANDLERS,
  both,
  createWorkerNoticeHandlers,
  createWorkerOutboxHandlers,
} from './consumers/registry.js';
export type { WorkerConsumerDependencies } from './consumers/registry.js';
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

// The relay's mail producer — the second producer on the `@tmanage/mail` port.
export {
  createClientRequestSubmittedMail,
  createClientRequestTransitionedMail,
} from './consumers/client-request-mail.js';
export { createCredentialChangeMail } from './consumers/credential-change-mail.js';
export {
  CredentialChangeMailer,
  composeCredentialChangeEmail,
} from './notifications/credential-change-mailer.js';
export type {
  CredentialChangeEmailFacts,
  CredentialChangeMailDelivery,
} from './notifications/credential-change-mailer.js';
export { ClientRequestMailer, mailKindForStatus } from './notifications/client-request-mailer.js';
// The storage-threshold mailer (USAGE-001), exported beside its siblings so a host that runs the
// relay in-process (the single-process Hostinger server) wires the same three mailers main.ts does.
export { UsageThresholdMailer } from './notifications/usage-threshold-mailer.js';
export type {
  ClientRequestMailDelivery,
  ClientRequestMailKind,
} from './notifications/client-request-mailer.js';
export {
  composeClarificationRequiredEmail,
  composeClientRequestReceivedEmail,
  composeRequestAcceptedEmail,
} from './notifications/client-request-email.js';
export type { ClientRequestEmailFacts } from './notifications/client-request-email.js';
export { findClientRequestMailFacts } from './common/database/mail-store.js';
export type { ClientRequestMailFacts } from './common/database/mail-store.js';

// RT-001 — the hub, the socket server, and the relay-to-socket seam.
export { RealtimeHub } from './realtime/hub.js';
export type { RealtimeEventFrame } from './realtime/hub.js';
export { createRealtimeServer } from './realtime/server.js';
export type { RealtimeServer, RealtimeServerOptions } from './realtime/server.js';
export { createMessageFanOut } from './realtime/fan-out.js';
export { checkConversationSubscription } from './common/database/realtime-store.js';
export type { SubscriptionVerdict } from './common/database/realtime-store.js';
export type { InternalRecipientCandidate } from './common/database/notifications-store.js';

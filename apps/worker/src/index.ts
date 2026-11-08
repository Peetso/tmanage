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
// A7 (0220) — the defer sweep, exported so the db suite drives the same reopen the
// `--sweep-deferred-requests` job runs.
export { REQUEST_REOPENED_NOTICE, sweepDeferredRequests } from './jobs/request-defer-sweeper.js';
export type { RequestDeferSweepResult } from './jobs/request-defer-sweeper.js';
export { createRequestDeferSweepStore } from './common/database/request-defer-store.js';
// C1 — the due-soon automation sweep, exported so the in-process worker (`apps/server`) and the db
// suite run the same `--sweep-due-soon` job.
export { DUE_SOON_TRIGGER, dueInDaysOf, sweepDueSoon } from './jobs/due-soon-sweeper.js';
export type { DueSoonSweepResult } from './jobs/due-soon-sweeper.js';
export { createDueSoonSweepStore } from './common/database/due-soon-store.js';
// 55-24: first-week getting-started nudges.
export { sweepGettingStartedNudges } from './jobs/getting-started-nudges.js';
export type { NudgeSweepResult } from './jobs/getting-started-nudges.js';
export { createGettingStartedNudgeStore } from './common/database/getting-started-nudge-store.js';
// R14-a — the outbound webhook delivery sweep, exported so the single Hostinger app
// (`apps/server`) delivers staged attempts on the same loop the standalone worker runs.
export {
  createWebhookDeliveryDeps,
  runWebhookDeliveryPass,
} from './consumers/webhook-deliveries.js';
export { runWebhookRetrySweepLoop } from './jobs/webhook-retry-sweeper.js';
// R15-c — the Slack / Teams channel post sweep, exported so the single Hostinger app (`apps/server`)
// posts staged channel notices on the same loop.
export {
  createChannelPostDeps,
  runChannelPostPass,
  runChannelPostSweepLoop,
} from './jobs/channel-post-sweeper.js';
// C2 — the invitation-expiry sweep, exported so the single Hostinger app (`apps/server`) runs the
// same `--sweep-invitations` job on its in-process timer.
export { sweepOverdueInvitations } from './invitations/invitation-sweep.js';
export type { InvitationSweepResult } from './invitations/invitation-sweep.js';
export { createInvitationSweepStore } from './common/database/invitations-sweep-store.js';
// 51-11 — the suppression read the in-process worker (apps/server) also uses.
export { createEmailSuppressionLookup } from './common/database/email-suppression-store.js';
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
export { PrivacyMailer } from './notifications/privacy-mailer.js';
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
export { createDirectMessageFanOut } from './realtime/fan-out.js';
// 53-01 — work events to project and personal topics.
export {
  createWorkFanOut,
  withWorkFanOut,
  WORK_FRAME_EVENT_TYPES,
} from './realtime/work-fan-out.js';
// R7 slice 5 — link previews on `message.created.v1` (SSRF-guarded unfurl, after commit).
export {
  createLinkPreviewConsumer,
  firstLinkOf,
  isRefusedAddress,
  parseOpenGraph,
  unfurl,
  withLinkPreviews,
} from './consumers/link-previews.js';
export type { UnfurledPage } from './consumers/link-previews.js';
export { checkConversationSubscription } from './common/database/realtime-store.js';
export type { SubscriptionVerdict } from './common/database/realtime-store.js';
export type { InternalRecipientCandidate } from './common/database/notifications-store.js';
// ---- platform-admin v2 · PA-05 ----
// The Support-session sweep, exported so the single Hostinger app (`apps/server`) schedules it and
// the db suite drives the same pass.
export { sweepSupportSessions } from './jobs/support-session-sweeper.js';
export type { SupportSweepResult } from './jobs/support-session-sweeper.js';
export { createSupportSessionSweepStore } from './common/database/support-session-sweep-store.js';
// ---- platform-admin v2 · PA-09 ----
// The Platform admin CSV export job, exported so the single Hostinger app (`apps/server`)
// schedules it and the db suite drives the same pass.
export { exportWriterFor, filesystemExportWriter, runExportJobs } from './jobs/export-jobs.js';
export type { ExportObjectWriter, ExportRunResult } from './jobs/export-jobs.js';
export { createExportJobStore } from './common/database/export-jobs-store.js';
// ---- platform-admin v2 · verifier ----
// The content purge (`--sweep-purge`: soft-deleted content past `purge_after`, then the PURGE_HOOKS
// such as the organization purge), exported so the single Hostinger app schedules it too.
export { runContentPurge } from './jobs/content-purge-entry.js';
export type { PurgeReport } from './jobs/purge-sweeper.js';
// ---- 56-31 ---- the mail priority lanes: the drainer and its store, exported so the db suite
// and the in-process worker (apps/server) run the same drain tick.
export {
  DRAIN_BATCH,
  DRAIN_INTERVAL_MS,
  createMailDrainerState,
  drainMailOnce,
  runMailDrainLoop,
} from './jobs/mail-drainer.js';
export type { MailDrainReport, MailDrainerDeps, MailDrainerState } from './jobs/mail-drainer.js';
export { createMailQueueStore } from './common/database/mail-queue-store.js';
export type { ClaimedMail, MailQueueStore } from './common/database/mail-queue-store.js';
// R16-b (52-05) — the 15-minute budget burn sweep, exported so the single Hostinger app
// (`apps/server`) runs it in-process.
export {
  BUDGET_BURN_INTERVAL_MS,
  budgetAlertRecipients,
  decideBurnAlert,
  sweepBudgetBurn,
} from './jobs/budget-burn-sweeper.js';
export type { BudgetBurnSweepResult } from './jobs/budget-burn-sweeper.js';
export { createBudgetBurnStore } from './common/database/budget-burn-store.js';
// R17-a (52-14) — the nightly finance facts rebuild loop, exported for an in-process host.
export {
  FINANCE_FACTS_TICK_MS,
  financeFactsDue,
  financeFactsWindow,
  runFinanceFactsLoop,
  runFinanceFactsRebuild,
} from './jobs/finance-facts-rebuild.js';
export type {
  FinanceFactsDeps,
  FinanceFactsResult,
  FinanceFactsStore,
} from './jobs/finance-facts-rebuild.js';
export { createFinanceFactsStore } from './common/database/finance-facts-store.js';
// R17-d (52-06) — the hourly retainer period roll, exported so the single Hostinger app
// (`apps/server`) runs it in-process.
export {
  RETAINER_ROLL_INTERVAL_MS,
  decideRetainerRoll,
  nextRetainerPeriod,
  retainerPeriodBounds,
  retainerRolloverIn,
  sweepRetainerPeriods,
} from './jobs/retainer-period-roll.js';
export type { RetainerRollResult, RetainerStore } from './jobs/retainer-period-roll.js';
export { createRetainerStore } from './common/database/retainer-store.js';

/**
 * `@tmanage/mail` — the mail port and its two drivers, shared by every app that sends.
 *
 * ## Why this is a package rather than a folder in `apps/api`
 *
 * The mailer landed inside the API because the API had the only producer: TEN-003's
 * invitation. The relay now has one too — a client whose request moved is told by email,
 * and the relay is where that fact becomes true. `18-REPOSITORY-STRUCTURE` forbids one app
 * importing another's `src/`, and duplicating an SMTP driver is how two subtly different
 * SMTP drivers happen. So the port and the drivers move here, which is the smallest thing
 * that lets both producers send through one transport.
 *
 * The package's list in `18-REPOSITORY-STRUCTURE` does not name `mail`; that tree was
 * written before a mail transport existed anywhere in this repository (the mailer is not in
 * `28-SPRINT-TICKETS` either). The divergence is deliberate and recorded in
 * `docs/implementation-status.md` rather than resolved by putting a network client in
 * `packages/domain`, which is pure by rule.
 *
 * **What is *not* here:** any template. A message's words belong to the producer that knows
 * what happened — `invitation-email.ts` in the API, `client-request-email.ts` in the worker
 * — and a shared template file would make one product decision on behalf of two features —
 * except 56-23's `templates/security_alert_digest.ts`, shared because the brief put it here.
 */

export type {
  MailDelivery,
  MailFromOptions,
  Mailer,
  MailMessage,
  MailReceipt,
  ReceiptMailer,
} from './mailer.js';
export { ConsoleMailer } from './console-mailer.js';
export { SmtpMailer } from './smtp-mailer.js';
export type { SmtpMailerOptions } from './smtp-mailer.js';
// 51-11 — deliverability: one-click unsubscribe, the notification transport, the host ceiling.
export {
  deriveUnsubscribeKey,
  emailAddressHash,
  listUnsubscribeHeaders,
  signUnsubscribeToken,
  verifyUnsubscribeToken,
} from './list-unsubscribe.js';
export { NotificationMailTransport } from './notification-transport.js';
export type { NotificationTransportOptions, SuppressionLookup } from './notification-transport.js';
export {
  HOST_MAIL_CEILING,
  MailCeilingReachedError,
  SendCeilingMailer,
  isBulkMessage,
} from './send-ceiling.js';
export type { SendCeiling } from './send-ceiling.js';
// 56-31 — the priority lanes and the queue the drainer empties.
export {
  CEILING_SAFETY_MARGIN,
  LOWER_LANE_SHARE,
  MAILBOXES,
  MAIL_LANES,
  allowance,
  authDeadlineMs,
  effectiveCeiling,
  hourWindowStart,
  isMailLane,
  laneForTemplate,
  laneIsPaused,
  lanePausedSettingKey,
  mailboxCeilingSettingKey,
  mailboxForLane,
  parseCeiling,
  spreadMinute,
} from './lanes.js';
export type { MailLane, Mailbox } from './lanes.js';
export {
  QueueMailer,
  decodeQueuedMessage,
  encodeQueuedMessage,
  recipientHash,
  withTemplateKey,
} from './queue-mailer.js';
export type { MailQueueEntry, MailQueueWriter, QueueMailerOptions } from './queue-mailer.js';
// 56-23 — the batched security alert's words (sent by the worker's security detector).
export {
  composeSecurityAlertDigest,
  securityDigestLabel,
} from './templates/security_alert_digest.js';
export type {
  SecurityDigestInput,
  SecurityDigestSignal,
} from './templates/security_alert_digest.js';
// 57-14 — the monthly go-to-market report's words (sent by the worker's growth rollup job).
export {
  GTM_CSV_HEADER,
  MONTHLY_GTM_REPORT_TEMPLATE_KEY,
  composeMonthlyGtmReport,
  gtmCsvCell,
  gtmRollupsToCsv,
} from './templates/monthly_gtm_report.js';
export type {
  GtmFunnelStep,
  GtmRollupCsvRow,
  MonthlyGtmReportInput,
} from './templates/monthly_gtm_report.js';

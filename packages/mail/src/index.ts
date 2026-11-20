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
  MailAttachment,
  MailDelivery,
  MailActingFor,
  MailFromOptions,
  MailIdentity,
  Mailer,
  MailMessage,
  MailPersonRef,
  MailPersonTopic,
  MailSender,
  MailReceipt,
  ReceiptMailer,
} from './mailer.js';
export { MAX_MAIL_MESSAGE_BYTES, safeAttachment } from './mailer.js';
export { ConsoleMailer } from './console-mailer.js';
// EMAILBUILD — who a message is from: the category map and the resolving decorator.
export {
  MAX_DISPLAY_NAME,
  MAX_SENDER_ADDRESS,
  MAX_SENDER_NAME,
  MAIL_IDENTITIES,
  SENDER_CATEGORIES,
  addressDomain,
  categoryForTemplate,
  cleanDisplayPart,
  formatFrom,
  isClientOnlyTemplate,
  isMailIdentity,
  validateSenderAddress,
  validateSenderName,
  TEMPLATE_KEYS,
} from './sender.js';
export type { MailLanguage, SenderCategory } from './sender.js';
export { SIGNATURE_TOKENS, SenderResolvingMailer } from './sender-resolver.js';
export {
  LINK_TOKENS,
  STILL_SENT_LINE,
  anchored,
  greeting,
  plainMailText,
  signOff,
  signOffText,
  unsubscribeFooter,
  workspaceReplyLine,
  workspaceSignOff,
} from './sign-off.js';
export type { SignOffKind } from './sign-off.js';
export {
  IdentityRoutingMailer,
  PERSON_IDLE_CLOSE_MS,
  PersonMailboxes,
  PersonMailboxUnavailableError,
  createIdentityMailers,
  isSmtpAuthFailure,
} from './identity-mailer.js';
export type { IdentityLogin, IdentityMailersOptions } from './identity-mailer.js';
export {
  CHECKED_MAILBOXES,
  MAIL_LOGIN_CHECK_TTL_MS,
  MailLoginCheck,
  resolveMailboxLogin,
} from './mailbox-login.js';
export type {
  CheckedMailbox,
  MailLoginCheckOptions,
  MailboxLogin,
  MailboxLoginInput,
  MailboxLoginReading,
  MailboxLoginState,
  MailboxLoginStatus,
} from './mailbox-login.js';
export { MAIL_PERSON_TOPICS, isMailPersonTopic, regionForTimezone } from './person-region.js';
export type { MailPersonRegion } from './person-region.js';
export type { MailPerson, SenderDirectory, SenderResolverOptions } from './sender-resolver.js';
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
  attachIfFits,
  decodeQueuedMessage,
  encodeQueuedMessage,
  recipientHash,
  withTemplateKey,
} from './queue-mailer.js';
export type { MailQueueEntry, MailQueueWriter, QueueMailerOptions } from './queue-mailer.js';
// 56-26 — bounces: the signed Message-ID, the RFC 3464 report reader, the company-scoped guard.
export { bounceMessageId, deriveBounceKey, readBounceMessageId } from './bounce-id.js';
export type { BounceMessageIdInput, BounceReference } from './bounce-id.js';
export { MAX_BOUNCE_BYTES, parseDeliveryReport } from './bounce-report.js';
export type { BounceKind, DeliveryReport } from './bounce-report.js';
export { parseFeedbackReport } from './feedback-report.js';
export type { FeedbackReport, FeedbackType } from './feedback-report.js';
export { BounceGuardMailer, MailRecipientSuppressedError, forCompany } from './bounce-guard.js';
export type { BounceSuppressionLookup } from './bounce-guard.js';
// MAILREST — a recipient refused at RCPT TO suppresses the address (every sending identity).
export {
  REFUSAL_SOFT_LIMIT,
  REFUSAL_SOFT_WINDOW_MS,
  SmtpRefusalMailer,
  nextRefusalState,
  refusalReference,
  smtpRecipientRefusal,
} from './bounce-refusal.js';
export type {
  RecipientBounceRecord,
  RefusalInput,
  RefusalRecorder,
  SmtpRefusal,
} from './bounce-refusal.js';
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

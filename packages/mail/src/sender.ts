/**
 * EMAILBUILD — who a message is from, decided in one place.
 *
 * Modelled on `lanes.ts`: a message carries a `templateKey`, never a sender, and this file is the
 * one place a template key becomes a sender category. An unknown or absent key is `security`
 * (noreply@, never a person): a producer cannot buy a friendlier sender by inventing a name.
 *
 * | category    | shown sender                                | reply goes to          |
 * | ----------- | ------------------------------------------- | ---------------------- |
 * | `security`  | "TManage Security" noreply@                 | nobody                 |
 * | `notice`    | "TManage" noreply@                          | nobody                 |
 * | `welcome`   | "TManage" hello@                            | hello@                 |
 * | `support`   | "TManage Support" support@                  | support@               |
 * | `person`    | "{personName} from TManage" (registry)      | the person's address   |
 * | `workspace` | "{actor} at {workspace} via TManage" noreply@ | the producer's route |
 * | `internal`  | "TManage" noreply@                          | nobody                 |
 * | `sales`     | "TManage Sales" sales@                      | the producer's address |
 *
 * Only the tips (`tip`) and the outreach campaign (`campaign_intro`, LANE-Q) reach `person`. Mail to a client never does (see `CLIENT_ONLY`).
 */

import type { MailIdentity } from './mailer.js';

export type SenderCategory =
  'security' | 'notice' | 'welcome' | 'support' | 'person' | 'workspace' | 'internal' | 'sales';

export const SENDER_CATEGORIES: readonly SenderCategory[] = Object.freeze([
  'security',
  'notice',
  'welcome',
  'support',
  'person',
  'workspace',
  'internal',
  'sales',
]);

/** The sending mailboxes (amendment 3): a closed list, checked again when a queued row is read. */
export const MAIL_IDENTITIES: readonly MailIdentity[] = Object.freeze([
  'noreply',
  'hello',
  'support',
  'sales',
  'person',
]);

export function isMailIdentity(value: unknown): value is MailIdentity {
  return typeof value === 'string' && (MAIL_IDENTITIES as readonly string[]).includes(value);
}

/** The language a message is written in; it picks the sender's display words. */
export type MailLanguage = 'en' | 'ar';

const CATEGORY_BY_TEMPLATE: Readonly<Record<string, SenderCategory>> = Object.freeze({
  // Codes, sign-in, security and privacy.
  sign_in_code: 'security',
  magic_link: 'security',
  password_reset: 'security',
  mfa_code: 'security',
  mfa_changed: 'security',
  new_device: 'security',
  email_change: 'security',
  password_changed: 'security',
  credential_change: 'security',
  erasure_confirmation: 'security',
  privacy_notice: 'security',
  sign_in_policy_changed: 'security',
  portal_sign_in: 'security',
  public_link_code: 'security',
  challenge_code: 'security',
  esign_code: 'security',
  // Normal notifications to team members.
  collaboration_notice: 'notice',
  digest: 'notice',
  nudge: 'notice',
  while_you_were_away: 'notice',
  slack: 'notice',
  teams: 'notice',
  // First contact.
  welcome: 'welcome',
  // Support answers, reports, staff notices, storage and usage notices to owners.
  support_reply: 'support',
  security_report_ack: 'support',
  platform_owner_notice: 'support',
  usage_threshold: 'support',
  storage_root: 'support',
  // Tips and reminders: the only template signed by a registry person.
  tip: 'person',
  // LANE-Q: the platform outreach campaign's first e-mail, from the assigned person's own mailbox.
  campaign_intro: 'person',
  // OUTREACH MANAGER: the campaign's one optional follow-up, from the same person's mailbox.
  campaign_followup: 'person',
  // An agency writing to its own client or invitee.
  invitation: 'workspace',
  client_request: 'workspace',
  client_invoice: 'workspace',
  esign_request: 'workspace',
  external_approval: 'workspace',
  inbound_ask_resend: 'workspace',
  // Read by TManage staff only.
  ops_alert: 'internal',
  security_alert_digest: 'internal',
  monthly_gtm_report: 'internal',
  // LANE-Q: a "Book a walkthrough" request, mailed to the sales team from sales@.
  walkthrough_request: 'sales',
});

/** PERSONMAIL. Every known template key (the fitness test walks them all, ADR-0013). */
export const TEMPLATE_KEYS: readonly string[] = Object.freeze(Object.keys(CATEGORY_BY_TEMPLATE));

/** Keys that always reach someone outside the team: never a TManage person. */
const CLIENT_ONLY = new Set([
  'client_request',
  'client_invoice',
  'esign_request',
  'external_approval',
  'inbound_ask_resend',
  'invitation',
]);

/** Whether a key is mailed to a client (or invitee) by definition. */
export function isClientOnlyTemplate(templateKey: string | undefined | null): boolean {
  if (typeof templateKey !== 'string') return false;
  return CLIENT_ONLY.has(templateKey) || templateKey.startsWith('portal_');
}

/** The sender category of a template. Unknown or absent → `security`. */
export function categoryForTemplate(
  templateKey: string | undefined | null,
  audience?: 'client',
): SenderCategory {
  const known =
    typeof templateKey === 'string' &&
    Object.prototype.hasOwnProperty.call(CATEGORY_BY_TEMPLATE, templateKey)
      ? CATEGORY_BY_TEMPLATE[templateKey]
      : undefined;
  const category = known ?? 'security';
  if (audience === 'client' || isClientOnlyTemplate(templateKey)) {
    return category === 'security' ? 'security' : 'workspace';
  }
  return category;
}

/** Longest stored person or display name part. */
export const MAX_SENDER_NAME = 80;
/** Longest composed display name ("{actor} at {workspace} via TManage"). */
export const MAX_DISPLAY_NAME = 120;
export const MAX_SENDER_ADDRESS = 190;

// Control characters (C0, DEL, C1), the line and paragraph separators, and the bidi controls a
// display name could use to reorder what a reader sees.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;
const NAME_FORBIDDEN = /["<>,;:\\]/u;
const ADDRESS =
  /^[a-z0-9](?:[a-z0-9._+-]{0,62}[a-z0-9])?@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/u;

/** A display name safe for a `From` header: no line breaks, controls, quotes or brackets. */
export function validateSenderName(name: string, max: number = MAX_SENDER_NAME): boolean {
  const trimmed = name.trim();
  return (
    trimmed.length > 0 &&
    trimmed === name &&
    name.length <= max &&
    !CONTROL.test(name) &&
    !NAME_FORBIDDEN.test(name)
  );
}

/** The domain of an address, lower-cased ('' when there is none). */
export function addressDomain(address: string): string {
  const at = address.lastIndexOf('@');
  return at < 0 ? '' : address.slice(at + 1).toLowerCase();
}

/**
 * A strict lower-case mailbox address, at most 190 characters. With `domain`, the address must be
 * on exactly that domain (the SMTP identity's: mail claiming another domain fails SPF/DMARC).
 */
export function validateSenderAddress(address: string, domain?: string): boolean {
  if (address.length > MAX_SENDER_ADDRESS || CONTROL.test(address)) return false;
  if (!ADDRESS.test(address)) return false;
  return domain === undefined || addressDomain(address) === domain.toLowerCase();
}

/** A name from the database made header-safe: forbidden characters become spaces, then cut. */
export function cleanDisplayPart(value: string, max = 40): string {
  return value
    .replace(new RegExp(`${CONTROL.source}|${NAME_FORBIDDEN.source}`, 'gu'), ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, max)
    .trim();
}

/** `"Name" <address>`; both parts must already be validated. */
export function formatFrom(name: string, address: string): string {
  return `"${name}" <${address}>`;
}

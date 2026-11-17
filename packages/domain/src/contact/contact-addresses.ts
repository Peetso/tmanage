/**
 * TManage's public mailboxes (NEWMAIL, 2026-11-17): the one source of truth for every contact
 * address a visitor, user, client or crawler sees. The product lives at tmanageapp.com and these
 * are the only mailboxes that exist there; never name another one.
 *
 * - `hello`   general and public contact, legal and privacy questions;
 * - `support` help and support, replies to support threads, security reports;
 * - `sales`   plans, pricing, procurement;
 * - `noreply` the system sender (the real sender comes from `EMAIL_FROM_ADDRESS`).
 */
export const CONTACT_EMAILS = Object.freeze({
  hello: 'hello@tmanageapp.com',
  support: 'support@tmanageapp.com',
  sales: 'sales@tmanageapp.com',
  noreply: 'noreply@tmanageapp.com',
} as const);

export type ContactMailbox = keyof typeof CONTACT_EMAILS;

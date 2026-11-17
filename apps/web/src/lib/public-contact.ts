import { CONTACT_EMAILS } from '@tmanage/domain';

/**
 * TManage's public contact details (AGENTREADY, 2026-11-16; NEWMAIL, 2026-11-17): the web's names
 * for the mailboxes in `@tmanage/domain` (`CONTACT_EMAILS`, the one source of truth), and the
 * company's own social profiles (Peter's links). There is no phone number.
 */
/** General and public contact: the website footer and the Organization structured data. */
export const HELLO_EMAIL = CONTACT_EMAILS.hello;
/** Help and support: support replies, accessibility feedback, security reports. */
export const SUPPORT_EMAIL = CONTACT_EMAILS.support;
/** Plans, pricing and procurement. */
export const SALES_EMAIL = CONTACT_EMAILS.sales;

export const SOCIAL_PROFILES = [
  'https://www.instagram.com/tmanageapp',
  'https://www.facebook.com/tmanageapp',
  'https://www.linkedin.com/company/tmanageapp',
] as const;

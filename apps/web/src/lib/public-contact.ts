// The leaf module, not the `@tmanage/domain` barrel: the barrel carries `node:crypto` (uuid-v7),
// and on the public pages' client bundle that pulled Next's crypto-browserify + util polyfills
// (about 0.5 MB) whose generator probe `Function("return function*() {}")` the Trusted Types
// default policy refuses, logging a console error on every page.
import { CONTACT_EMAILS } from '@tmanage/domain/contact-addresses';

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

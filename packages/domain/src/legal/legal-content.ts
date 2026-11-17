/**
 * The public legal documents — the Terms of Service and the Privacy Policy (x188).
 *
 * Code-defined copy with no I/O. It lives here, not in the API, because two surfaces need the very
 * same object: the API's `GET /v1/public/site/legal/:doc` serves it, and the web's `/legal/*` pages
 * render it on the server, so the policy text is in the HTML itself for readers and crawlers that
 * run no JavaScript (Google's OAuth brand verification). `effectiveDate` is a frozen ISO date.
 *
 * platform-admin v2 · PA-03 (2026-10-28): both documents gain the `operator-access` section (SPEC P1
 * and §8 — the platform operator may read and change an organization's data for support, safety
 * and legal reasons, and every such access is recorded), the effective date moves to 2026-10-28,
 * and the Arabic documents are built here too ({@link LEGAL_DOCUMENTS_AR}, from
 * `legal-content-ar.ts`) so a caller asks for a document by locale ({@link legalDocumentFor}).
 * `LEGAL_DOCUMENTS` stays the English map every existing caller reads.
 */

import { CONTACT_EMAILS } from '../contact/contact-addresses.js';
import { LEGAL_COPY_AR, OPERATOR_ACCESS_AR } from './legal-content-ar.js';

/** Legal and privacy questions go to the general mailbox. */
const LEGAL_CONTACT_EMAIL = CONTACT_EMAILS.hello;

/** The two legal documents — a closed allowlist. */
export type LegalDocumentKey = 'terms' | 'privacy';

/** One legal document: a title, an effective date, an intro and its sections in reading order. */
export interface LegalDocument {
  readonly doc: LegalDocumentKey;
  readonly title: string;
  /** The date the document took effect, as a stable `YYYY-MM-DD` string. */
  readonly effectiveDate: string;
  readonly intro: string;
  /** `id` is the DOM anchor and React key. */
  readonly sections: readonly {
    readonly id: string;
    readonly heading: string;
    readonly body: string;
  }[];
}

/**
 * Copy for one legal document. Each section is frozen so the payload stays deterministic.
 */
function section(id: string, heading: string, body: string) {
  return Object.freeze({ id, heading, body });
}

/** The date both documents took effect — bumped whenever their text changes. */
export const LEGAL_EFFECTIVE_DATE = '2026-10-28';

/** The id (and DOM anchor) of the operator-access section, present in both documents. */
export const OPERATOR_ACCESS_SECTION_ID = 'operator-access';

/** SPEC §8, verbatim — the English operator-access clause. */
const OPERATOR_ACCESS_EN = Object.freeze({
  heading: 'Operator access for support, safety and legal reasons',
  body: 'TManage staff with platform-administrator rights can view and change data in any organization’s workspace — including messages, files, documents and settings — when needed to provide support you ask for, to investigate abuse, security incidents or policy violations, to keep the service running, or to meet a legal obligation. Such access is restricted to named administrators, requires a fresh identity confirmation, is limited in time, and is recorded (who, when, which organization, what was changed). Organization owners can see these entries in their audit log. We do not use this access for advertising or to read your content without one of these reasons.',
});

/** The two frozen legal documents, keyed by the allowlisted doc id. Last updated 28 October 2026. */
export const LEGAL_DOCUMENTS: Readonly<Record<LegalDocumentKey, LegalDocument>> = Object.freeze({
  terms: Object.freeze({
    doc: 'terms',
    title: 'Terms of Service',
    effectiveDate: LEGAL_EFFECTIVE_DATE,
    intro:
      'Last updated: 28 October 2026. These terms govern access to and use of TManage, a work-management service at tmanageapp.com operated by Peter Designs (peetrix.com). By creating an account or using the service, an organization and its members agree to them.',
    sections: Object.freeze([
      section(
        'operator',
        'Who provides the service',
        `TManage is provided by Peter Designs (peetrix.com), referred to here as “TManage”, “we” or “us”. Questions about these terms can be sent to ${LEGAL_CONTACT_EMAIL}.`,
      ),
      section(
        'accounts',
        'Accounts and organizations',
        'The service is used through an organization. The person who creates an organization is responsible for the members they invite and for the roles those members hold. Each member is responsible for keeping their own credentials secure and for the activity under their account. You must give accurate account information and must be old enough to form a binding contract where you live, and at least 16.',
      ),
      section(
        'acceptable-use',
        'Acceptable use',
        'The service may not be used to break the law, to infringe the rights of others, to send spam or malware, or to attempt to access data belonging to another organization. Automated access must respect published limits and must not degrade the service for other customers.',
      ),
      section(
        'customer-data',
        'Your content',
        'Content an organization puts into the service remains that organization’s content. The organization grants TManage only the permissions needed to operate the service — to store, process, and display that content back to the organization’s own members and to the client audiences the organization chooses to share it with. How we handle personal data is described in the Privacy Policy at https://tmanageapp.com/legal/privacy, which forms part of these terms.',
      ),
      section(OPERATOR_ACCESS_SECTION_ID, OPERATOR_ACCESS_EN.heading, OPERATOR_ACCESS_EN.body),
      section(
        'google-drive',
        'Google Drive and other integrations',
        'An organization may connect third-party services such as Google Drive. A connection is made only when a user chooses it and approves the access on the provider’s own consent screen; the provider’s own terms also apply to that account. For Google Drive, TManage requests only the drive.file scope (the files TManage creates or the user picks) and the basic profile email of the connecting account, and uses that access only to store and retrieve the workspace’s attachments in the customer’s own Drive. Access can be revoked at any time with Disconnect in TManage or on the Google Account permissions page (https://myaccount.google.com/permissions). TManage’s use and transfer of information received from Google APIs to any other app will adhere to the Google API Services User Data Policy, including the Limited Use requirements (https://developers.google.com/terms/api-services-user-data-policy).',
      ),
      section(
        'availability',
        'Availability and changes',
        'The service is provided on an ongoing basis and may change as features are added or retired. Material changes to these terms will be communicated to organization owners before they take effect. Planned maintenance and current system status are published on the status page.',
      ),
      section(
        'termination',
        'Termination',
        'An organization may stop using the service at any time. On closure, the organization can export its records, after which its data is removed as described in the Privacy Policy. The service may suspend access that breaks these terms or puts other customers or the service at risk.',
      ),
      section(
        'liability',
        'Warranty and liability',
        'The service is provided as is, without warranties beyond those that cannot be excluded by law. To the extent the law allows, TManage is not liable for indirect or consequential losses. Nothing here limits liability that cannot be limited by law.',
      ),
      section(
        'contact',
        'Contact',
        `Peter Designs (peetrix.com), operator of TManage. Email: ${LEGAL_CONTACT_EMAIL}. Website: https://tmanageapp.com.`,
      ),
    ]),
  }),
  privacy: Object.freeze({
    doc: 'privacy',
    title: 'Privacy Policy',
    effectiveDate: LEGAL_EFFECTIVE_DATE,
    intro:
      'Last updated: 28 October 2026. This policy explains what personal data TManage collects, how we use and share it, how long we keep it, how we protect it, and the rights you have. A dedicated section explains how TManage handles data it receives from Google when a workspace connects Google Drive.',
    sections: Object.freeze([
      section(
        'who-we-are',
        'Who we are',
        `TManage is a work-management service at tmanageapp.com, operated by Peter Designs (peetrix.com) — “TManage”, “we” or “us”. We are the controller of account, website and service-operation data. For the content an organization puts into its workspace, the organization is the controller and we process that content on its behalf. Contact: ${LEGAL_CONTACT_EMAIL}.`,
      ),
      section(
        'what-we-collect',
        'What data we collect',
        'Account data: your name, email address, a hash of your password, multi-factor authentication settings, your role and the organizations you belong to. Workspace content: the projects, tasks, messages, comments, documents, decisions, time entries and other records members create. Files: attachments members upload or link, with their names, sizes and types. Billing details an organization enters for invoicing, such as a billing contact and tax details. Usage and log data: IP address, browser and device type, pages and features used, sign-in events, audit entries and security telemetry; user-supplied content is redacted from operator logs. Cookies, described below. Messages you send us through the contact form or by email.',
      ),
      section(
        'cookies',
        'Cookies',
        'TManage uses only cookies that the service needs to work: a session cookie that keeps you signed in, a refresh cookie scoped to the sign-in path, and a security cookie that protects forms against cross-site request forgery. We do not use advertising cookies or third-party tracking cookies. If you block these cookies you will not be able to sign in.',
      ),
      section(
        'how-we-use-it',
        'How we use data',
        'We use personal data to create and secure accounts and sign you in; to provide the workspace features your organization uses, including sharing with the client portals it chooses; to send service email such as invitations, password resets, notifications and security alerts; to keep audit records and to detect, prevent and investigate abuse and security incidents; to answer support requests; and to keep the service reliable, using aggregated or de-identified information where possible. We do not sell personal data, do not use it for advertising, and do not use workspace content or Google user data to train artificial-intelligence models.',
      ),
      section(
        'legal-bases',
        'Legal bases',
        'Where data-protection laws such as the GDPR apply, we rely on: performance of a contract, to provide the service an organization or member signed up for; legitimate interests, to secure the service, prevent abuse, keep audit records and improve reliability, balanced against your rights; legal obligation, where we must keep records or answer lawful requests; and consent, where we ask for it — for example when you connect a Google account — which you can withdraw at any time.',
      ),
      section(
        'google-user-data',
        'Google user data',
        'When a workspace member connects Google Drive, TManage requests only the drive.file scope, which lets TManage see and manage only the files that TManage itself creates or that you explicitly pick — never the rest of your Drive — plus the basic profile email address of the connecting Google account, so the connection can be identified and shown. TManage uses this access only to store and retrieve the workspace’s attachments in the customer’s own Google Drive, at the user’s request. TManage stores an encrypted OAuth refresh token for the connection and the Drive file ids of the attachments it manages; the file contents stay in your Google Drive. Google user data is shared with no one: it is not sold, not used for advertising, not used to train AI models, and not transferred to third parties, except where the law requires it. You can revoke access at any time with Disconnect in TManage, which erases the stored token, and by removing TManage on your Google Account permissions page (https://myaccount.google.com/permissions). When you disconnect, or when the workspace is closed, TManage erases the stored token and the stored file ids; the files themselves remain in your Drive under your control. TManage’s use and transfer of information received from Google APIs to any other app will adhere to the Google API Services User Data Policy, including the Limited Use requirements. The policy is at https://developers.google.com/terms/api-services-user-data-policy.',
      ),
      section(
        'subprocessors',
        'Sharing and sub-processors',
        'We share personal data only with providers that process it on our behalf, under contract and only for the stated purpose: Hostinger, for application, database and file hosting; the email provider used for transactional email, when configured; and Google, only when a workspace connects Google Drive. Inside the service, content is visible to the members and client contacts your organization gives access to. We may disclose data where the law requires it, to protect the safety of users or the service, or as part of a merger or acquisition, in which case this policy continues to apply. We never sell or rent personal data. The current sub-processor list is also published on the security page.',
      ),
      section(
        'isolation',
        'Separation between organizations',
        'Each organization’s data is isolated. Cross-organization reads are refused before any handler runs, so one customer’s members cannot see another customer’s data through the service.',
      ),
      section(OPERATOR_ACCESS_SECTION_ID, OPERATOR_ACCESS_EN.heading, OPERATOR_ACCESS_EN.body),
      section(
        'retention',
        'Retention and deletion',
        'Account and workspace data are kept while the account or organization is active. When an organization is closed, its owners can first export their records; the workspace data is then deleted. Security and audit records are kept only as long as needed to protect the service, investigate incidents or meet legal obligations. A member can ask for their account to be deleted; content they created in an organization’s workspace stays with that organization, which controls it. Google data is deleted as described in the Google user data section.',
      ),
      section(
        'security',
        'Security',
        'We protect data with encryption in transit (HTTPS), hashed passwords, optional multi-factor authentication, encryption of stored secrets such as OAuth tokens, strict separation between organizations, role-based access, rate limiting and audit logging. No system is perfectly secure; if a breach affects your personal data we will notify affected organizations and authorities as the law requires.',
      ),
      section(
        'your-rights',
        'Your rights',
        `Depending on where you live, you may have the right to access, correct, export or delete your personal data, to restrict or object to its processing, to withdraw consent, and to complain to a data-protection authority. Members can view and correct their own profile in TManage, and organization owners can export workspace data. To make a request — including a data export or deletion request — email ${LEGAL_CONTACT_EMAIL} using the address on your account; we answer within 30 days. Where the data sits in an organization’s workspace, we may pass the request to that organization, which controls the content.`,
      ),
      section(
        'children',
        'Children',
        'TManage is a business tool and is not directed to children. It is not meant for anyone under 16, and we do not knowingly collect their personal data. If you believe a child has given us personal data, contact us and we will delete it.',
      ),
      section(
        'international',
        'International transfers',
        'Data is hosted with Hostinger, and our providers may process data in countries other than yours. Where personal data is transferred across borders, we rely on appropriate safeguards, such as standard contractual clauses, where the law requires them.',
      ),
      section(
        'changes',
        'Changes to this policy',
        'We may update this policy as the service changes. The date at the top shows the current version. For material changes we will tell organization owners by email or in the app before they take effect.',
      ),
      section(
        'contact',
        'Contact',
        `Peter Designs (peetrix.com), operator of TManage. Email: ${LEGAL_CONTACT_EMAIL}. Website: https://tmanageapp.com.`,
      ),
    ]),
  }),
}) as Readonly<Record<LegalDocumentKey, LegalDocument>>;

// ---- platform-admin v2 · PA-03 ----

/** The locales the legal documents are published in. English prevails. */
export type LegalLocale = 'en' | 'ar';
export const LEGAL_LOCALES: readonly LegalLocale[] = ['en', 'ar'];

/** Shown under the intro of each Arabic legal page. */
export { LEGAL_ENGLISH_PREVAILS_AR } from './legal-content-ar.js';
export { LEGAL_COPY_AR } from './legal-content-ar.js';
export type { ArabicLegalCopy } from './legal-content-ar.js';

/**
 * One English document rendered in Arabic: the same ids, order and effective date, each section's
 * heading and body from the translation (English where a section has none).
 */
function arabicDocument(english: LegalDocument): LegalDocument {
  const copy = LEGAL_COPY_AR[english.doc];
  return Object.freeze({
    doc: english.doc,
    title: copy.title,
    effectiveDate: english.effectiveDate,
    intro: copy.intro,
    sections: Object.freeze(
      english.sections.map((entry) => {
        const translated = copy.sections[entry.id];
        return section(
          entry.id,
          translated?.heading ?? entry.heading,
          translated?.body ?? entry.body,
        );
      }),
    ),
  });
}

/** The Arabic documents, keyed like {@link LEGAL_DOCUMENTS}. */
export const LEGAL_DOCUMENTS_AR: Readonly<Record<LegalDocumentKey, LegalDocument>> = Object.freeze({
  terms: arabicDocument(LEGAL_DOCUMENTS.terms),
  privacy: arabicDocument(LEGAL_DOCUMENTS.privacy),
});

/** Every document by locale then key: `LEGAL_DOCUMENTS_BY_LOCALE.ar.privacy`. */
export const LEGAL_DOCUMENTS_BY_LOCALE: Readonly<
  Record<LegalLocale, Readonly<Record<LegalDocumentKey, LegalDocument>>>
> = Object.freeze({ en: LEGAL_DOCUMENTS, ar: LEGAL_DOCUMENTS_AR });

/** Normalise any BCP-47 tag (`ar-EG`, `en-GB`, `fr`) to a published legal locale. */
export function legalLocaleOf(tag: string | null | undefined): LegalLocale {
  return (tag ?? '').split('-')[0]?.toLowerCase() === 'ar' ? 'ar' : 'en';
}

/** One document in the reader's language; English for every locale but Arabic. */
export function legalDocumentFor(
  doc: LegalDocumentKey,
  locale: string | null | undefined,
): LegalDocument {
  return LEGAL_DOCUMENTS_BY_LOCALE[legalLocaleOf(locale)][doc];
}

/** The SPEC §8 operator-access clause in both locales (for tests and the runbook). */
export const OPERATOR_ACCESS_CLAUSE: Readonly<
  Record<LegalLocale, { readonly heading: string; readonly body: string }>
> = Object.freeze({ en: OPERATOR_ACCESS_EN, ar: OPERATOR_ACCESS_AR });

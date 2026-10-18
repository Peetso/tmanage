/**
 * Public & trust site (module 1) — the marketing home content.
 *
 * The one job of this service is to answer the public landing page's content as a deterministic,
 * code-defined payload. There is no database read and no tenant: the copy is the same for every
 * visitor, authenticated or not, so a round-trip to a per-tenant store would be both wrong and a
 * needless dependency. The value is frozen so a caller cannot mutate the shared instance.
 *
 * Why a service rather than a constant inlined in the controller: the controller stays a thin HTTP
 * adapter (ADR-0001 layer boundaries), the payload is unit-testable on its own, and a later slice
 * that wants the same copy on a second surface (the footer, an OG card) injects this rather than
 * copying the strings.
 */

/** DI token for the public-content service (ADR-0003: every provider carries an explicit token). */
export const PUBLIC_CONTENT_SERVICE = Symbol('tmanage.public-content.service');

/**
 * The marketing home payload — hero copy, the feature blurbs, and the two call-to-action targets.
 *
 * Nested shapes are inlined rather than exported so the API↔web pairing is the single
 * `PublicHomeView` projection (contracts-check enumerates every exported `…View`, and every web
 * `export interface`). The CTA `href`s are in-app routes the public shell already owns.
 */
export interface PublicHomeView {
  readonly hero: {
    readonly title: string;
    readonly subtitle: string;
    readonly primaryCta: { readonly label: string; readonly href: string };
    readonly secondaryCta: { readonly label: string; readonly href: string };
  };
  readonly features: readonly {
    readonly title: string;
    readonly body: string;
  }[];
}

/**
 * One resource/guide entry as the public index renders it: the card fields (`slug`, `title`,
 * `summary`, `category`) plus the article `body` the detail page shows. The list projection omits
 * `body`; the detail projection is this whole shape. The `slug` is the stable, in-URL identifier and
 * is only ever chosen from this fixed map — a caller never introduces one.
 */
interface PublicResourceEntry {
  readonly slug: string;
  readonly title: string;
  readonly summary: string;
  readonly category: string;
  readonly body: string;
}

/**
 * The resources/guides **index** payload (module 1). Each card carries the four list fields; the
 * article body is fetched separately by slug so the index stays small. Nested shape inlined so the
 * API↔web pairing is the single `PublicResourceListView` projection.
 */
export interface PublicResourceListView {
  readonly resources: readonly {
    readonly slug: string;
    readonly title: string;
    readonly summary: string;
    readonly category: string;
  }[];
}

/**
 * One resource/guide **article** payload (module 1) — the four card fields plus the rendered `body`.
 * Paired Exact with the web's `PublicResourceView`.
 */
export interface PublicResourceView {
  readonly slug: string;
  readonly title: string;
  readonly summary: string;
  readonly category: string;
  readonly body: string;
}

/**
 * The fixed resource/guide catalog — deterministic, code-defined content, the same for every
 * visitor. Frozen so the shared instance cannot be mutated. It is the only set of slugs the `:slug`
 * read will ever serve: an unknown slug is a 404, never an arbitrary lookup path.
 */
const RESOURCES: readonly PublicResourceEntry[] = Object.freeze([
  Object.freeze({
    slug: 'getting-started',
    title: 'Getting started with TManage',
    summary:
      'Set up your first project, invite your team, and share a client portal in an afternoon.',
    category: 'Guides',
    body: 'TManage brings projects, approvals, and the client portal into one place. Create an organization, add a project, and invite the people doing the work. Each work item carries the one reason it needs attention today, so the next step is always visible. When you are ready to share progress, publish a portal update — your client sees exactly what you allow, and nothing else.',
  }),
  Object.freeze({
    slug: 'client-portal-tour',
    title: 'A tour of the client portal',
    summary: 'What clients see, how approvals flow, and how requests come back to your team.',
    category: 'Guides',
    body: 'The client portal is scoped to a single client: they see the deliverables, updates, and approvals you publish, and can raise requests that land back in your inbox. Nothing internal — other clients, internal notes, unpublished work — is ever reachable from the portal. Approvals record who decided and when, so the audit trail is the record rather than an email thread.',
  }),
  Object.freeze({
    slug: 'roles-and-permissions',
    title: 'Understanding roles and permissions',
    summary: 'How capabilities, roles, and tenant scope keep the right people on the right work.',
    category: 'Reference',
    body: 'Access in TManage is capability-based: a role is a named bundle of capabilities, and every action checks the capability it needs before it runs. Scope is per-organization, so a person only ever sees the organizations they belong to. Custom roles let you clone a starting point and adjust it without touching anyone else.',
  }),
  Object.freeze({
    slug: 'delivery-insights',
    title: 'Reading delivery insights',
    summary: 'Workload, delivery health, and adoption read straight from the work itself.',
    category: 'Guides',
    body: 'Insights in TManage are computed from the work, not entered by hand: workload shows who is carrying what, delivery health surfaces where a project is slipping, and adoption shows how the team is actually using the tool. Because the numbers are read from the record, they are always current — there is no snapshot to refresh.',
  }),
]) as readonly PublicResourceEntry[];

/** The index projection, computed once from the catalog and frozen — the same payload every call. */
const RESOURCE_LIST: PublicResourceListView = Object.freeze({
  resources: Object.freeze(
    RESOURCES.map((entry) =>
      Object.freeze({
        slug: entry.slug,
        title: entry.title,
        summary: entry.summary,
        category: entry.category,
      }),
    ),
  ),
}) as PublicResourceListView;

/**
 * The single, frozen payload. `as const` plus `Object.freeze` on the arrays means neither the
 * service nor any consumer can mutate what every request shares.
 */
const HOME: PublicHomeView = Object.freeze({
  hero: Object.freeze({
    title: 'Run client work without the status meeting',
    subtitle:
      'TManage keeps projects, approvals, and the client portal in one place, so the next step is always visible and nobody has to ask where things stand.',
    primaryCta: Object.freeze({ label: 'Get started', href: '/sign-in' }),
    secondaryCta: Object.freeze({ label: 'Sign in', href: '/sign-in' }),
  }),
  features: Object.freeze([
    Object.freeze({
      title: 'One place for the work',
      body: 'Projects, tasks, decisions, and documents live together, each item carrying the one reason it needs attention today.',
    }),
    Object.freeze({
      title: 'A portal your clients trust',
      body: 'Share deliverables, collect approvals, and answer requests through a portal scoped to exactly what each client is allowed to see.',
    }),
    Object.freeze({
      title: 'Answers, not exports',
      body: 'Workload, delivery health, and adoption are read straight from the work itself, so the numbers are the record rather than a snapshot.',
    }),
  ]),
}) as PublicHomeView;

/**
 * The two legal documents the public site serves — `terms` and `privacy` (x188).
 *
 * This is a closed, two-value allowlist rather than an open key, and that is the security line of
 * the slice: the controller maps `:doc` through this union, so an arbitrary path segment can never
 * index into the content map. Adding a third document is a deliberate edit here and to the
 * controller's allowlist, not a URL a caller can invent.
 */
export type LegalDoc = 'terms' | 'privacy';

/**
 * One long-form legal document as the public page reads it — module 1 (x188).
 *
 * Code-defined copy, like the trust page (x158): no database, no tenant, no session. The
 * `effectiveDate` is a frozen ISO date, not `new Date()`, so the read is deterministic and a
 * document's stated effective date changes only when the copy does — a legal page whose date drifts
 * every request would be worse than useless.
 *
 * The section shape is inlined rather than exported so the API↔web pairing is the single
 * `PublicLegalView` projection (contracts-check enumerates every exported `…View`). Paired `Exact`
 * with the web's `PublicLegalView` (`apps/web/src/lib/api/public-legal.ts`) in
 * `e2e/contracts/api-web-shapes.ts`, so the terms the screen renders cannot drift from the terms
 * the API serves.
 */
export interface PublicLegalView {
  /** Which document this is — one of the two allowlisted keys. */
  readonly doc: LegalDoc;
  readonly title: string;
  /** The date the document took effect, as a stable `YYYY-MM-DD` string. */
  readonly effectiveDate: string;
  /** A short orientation paragraph shown above the sections and used for the anchor-nav summary. */
  readonly intro: string;
  /** The document's sections, in reading order. `id` is the DOM anchor and React key. */
  readonly sections: readonly {
    readonly id: string;
    readonly heading: string;
    readonly body: string;
  }[];
}

/**
 * Copy for one legal document. Each section is frozen so the payload stays deterministic.
 * `section` is a small helper, not exported: the API↔web pairing stays the single `PublicLegalView`.
 */
function section(id: string, heading: string, body: string) {
  return Object.freeze({ id, heading, body });
}

/** The two frozen legal documents, keyed by the allowlisted doc id. Last updated 18 October 2026. */
const LEGAL: Readonly<Record<LegalDoc, PublicLegalView>> = Object.freeze({
  terms: Object.freeze({
    doc: 'terms',
    title: 'Terms of Service',
    effectiveDate: '2026-10-18',
    intro:
      'Last updated: 18 October 2026. These terms govern access to and use of TManage, a work-management service at tmanage.peetrix.com operated by Peter Designs (peetrix.com). By creating an account or using the service, an organization and its members agree to them.',
    sections: Object.freeze([
      section(
        'operator',
        'Who provides the service',
        'TManage is provided by Peter Designs (peetrix.com), referred to here as “TManage”, “we” or “us”. Questions about these terms can be sent to tm-support@peetrix.com.',
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
        'Content an organization puts into the service remains that organization’s content. The organization grants TManage only the permissions needed to operate the service — to store, process, and display that content back to the organization’s own members and to the client audiences the organization chooses to share it with. How we handle personal data is described in the Privacy Policy at https://tmanage.peetrix.com/legal/privacy, which forms part of these terms.',
      ),
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
        'Peter Designs (peetrix.com), operator of TManage. Email: tm-support@peetrix.com. Website: https://tmanage.peetrix.com.',
      ),
    ]),
  }),
  privacy: Object.freeze({
    doc: 'privacy',
    title: 'Privacy Policy',
    effectiveDate: '2026-10-18',
    intro:
      'Last updated: 18 October 2026. This policy explains what personal data TManage collects, how we use and share it, how long we keep it, how we protect it, and the rights you have. A dedicated section explains how TManage handles data it receives from Google when a workspace connects Google Drive.',
    sections: Object.freeze([
      section(
        'who-we-are',
        'Who we are',
        'TManage is a work-management service at tmanage.peetrix.com, operated by Peter Designs (peetrix.com) — “TManage”, “we” or “us”. We are the controller of account, website and service-operation data. For the content an organization puts into its workspace, the organization is the controller and we process that content on its behalf. Contact: tm-support@peetrix.com.',
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
        'Depending on where you live, you may have the right to access, correct, export or delete your personal data, to restrict or object to its processing, to withdraw consent, and to complain to a data-protection authority. Members can view and correct their own profile in TManage, and organization owners can export workspace data. To make a request — including a data export or deletion request — email tm-support@peetrix.com using the address on your account; we answer within 30 days. Where the data sits in an organization’s workspace, we may pass the request to that organization, which controls the content.',
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
        'Peter Designs (peetrix.com), operator of TManage. Email: tm-support@peetrix.com. Website: https://tmanage.peetrix.com.',
      ),
    ]),
  }),
}) as Readonly<Record<LegalDoc, PublicLegalView>>;

/**
 * The public marketing content. No tenant, no database, no session — the payload is the same for
 * everyone and is served through the `@Public()` door on the controller.
 */
export class PublicContentService {
  /** The marketing home content. Deterministic: the same frozen payload every call. */
  home(): PublicHomeView {
    return HOME;
  }

  /** The resources/guides index — every entry's card fields, no bodies. Deterministic. */
  resources(): PublicResourceListView {
    return RESOURCE_LIST;
  }

  /**
   * One resource/guide article by slug. Returns `undefined` for any slug not in the fixed catalog,
   * which the controller turns into a 404 — the lookup is a membership test against the frozen map,
   * never an arbitrary path, so an unknown or crafted slug can only miss.
   */
  resource(slug: string): PublicResourceView | undefined {
    return RESOURCES.find((entry) => entry.slug === slug);
  }

  /**
   * The requested legal document, or `undefined` for anything outside the two-value allowlist.
   *
   * The controller narrows `:doc` before calling this and turns `undefined` into a 404, so an
   * arbitrary path segment never reaches — and never indexes — the content map. Returning
   * `undefined` rather than throwing keeps the service a pure lookup and the HTTP concern in the
   * controller.
   */
  legal(doc: string): PublicLegalView | undefined {
    return doc === 'terms' || doc === 'privacy' ? LEGAL[doc] : undefined;
  }
}

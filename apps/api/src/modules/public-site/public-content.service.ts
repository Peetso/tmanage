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

/** The two frozen legal documents, keyed by the allowlisted doc id. */
const LEGAL: Readonly<Record<LegalDoc, PublicLegalView>> = Object.freeze({
  terms: Object.freeze({
    doc: 'terms',
    title: 'Terms of Service',
    effectiveDate: '2026-01-01',
    intro:
      'These terms govern access to and use of the TManage service. By creating an account or using the service, an organization and its members agree to them.',
    sections: Object.freeze([
      Object.freeze({
        id: 'accounts',
        heading: 'Accounts and organizations',
        body: 'The service is used through an organization. The person who creates an organization is responsible for the members they invite and for the roles those members hold. Each member is responsible for keeping their own credentials secure and for the activity under their account.',
      }),
      Object.freeze({
        id: 'acceptable-use',
        heading: 'Acceptable use',
        body: 'The service may not be used to break the law, to infringe the rights of others, or to attempt to access data belonging to another organization. Automated access must respect published limits and must not degrade the service for other customers.',
      }),
      Object.freeze({
        id: 'customer-data',
        heading: 'Your content',
        body: 'Content an organization puts into the service remains that organization’s content. The organization grants TManage only the permissions needed to operate the service — to store, process, and display that content back to the organization’s own members and to the client audiences the organization chooses to share it with.',
      }),
      Object.freeze({
        id: 'availability',
        heading: 'Availability and changes',
        body: 'The service is provided on an ongoing basis and may change as features are added or retired. Material changes to these terms will be communicated before they take effect. Planned maintenance and current system status are published on the status page.',
      }),
      Object.freeze({
        id: 'termination',
        heading: 'Termination',
        body: 'An organization may stop using the service at any time. On closure, the organization can export its records, after which its data is removed. The service may suspend access that puts other customers or the service at risk.',
      }),
      Object.freeze({
        id: 'liability',
        heading: 'Warranty and liability',
        body: 'The service is provided as is, without warranties beyond those that cannot be excluded by law. Nothing here limits liability that cannot be limited by law. Questions about these terms are welcome at the contact address on the site.',
      }),
    ]),
  }),
  privacy: Object.freeze({
    doc: 'privacy',
    title: 'Privacy Policy',
    effectiveDate: '2026-01-01',
    intro:
      'This policy explains what personal data TManage handles, why, and the choices an organization and its members have. It describes the design of the service; it is not a live report of any single account.',
    sections: Object.freeze([
      Object.freeze({
        id: 'what-we-collect',
        heading: 'What we collect',
        body: 'Account details needed to sign in and identify a member (name, email, and authentication factors), the content an organization creates in the service, and technical records such as audit entries and security telemetry. User-supplied payloads are redacted from operator-facing telemetry.',
      }),
      Object.freeze({
        id: 'how-we-use-it',
        heading: 'How we use it',
        body: 'Personal data is used to operate the service for the organization: to authenticate members, enforce per-organization access, deliver the work and portal features, and keep the audit and security records the service depends on. It is not sold, and it is not used to advertise.',
      }),
      Object.freeze({
        id: 'isolation',
        heading: 'Separation between organizations',
        body: 'Each organization’s data is isolated. Cross-organization reads are refused before any handler runs, so one customer’s members cannot see another customer’s data through the service.',
      }),
      Object.freeze({
        id: 'subprocessors',
        heading: 'Service providers',
        body: 'A small, named set of providers handle data on TManage’s behalf — hosting, file storage, and transactional email — each only for the stated purpose. The current list is published on the security and trust page.',
      }),
      Object.freeze({
        id: 'retention',
        heading: 'Retention and deletion',
        body: 'Data is retained for the life of the account and removed on request when an organization is closed. An organization can export its own records and audit trail before closure.',
      }),
      Object.freeze({
        id: 'your-rights',
        heading: 'Your choices',
        body: 'Members can access and correct their own account details. Requests about personal data, including access and deletion, can be raised through the organization’s administrators or the contact address on the site.',
      }),
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

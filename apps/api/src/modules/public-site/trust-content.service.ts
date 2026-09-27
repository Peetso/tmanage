/**
 * The public security-and-trust content — module 1 (x158).
 *
 * `38-MODULE-MAP` §Public site lists a security/trust page that a prospect or a customer's
 * security reviewer can read before anyone signs in. Audit rank #1 recorded it Missing: there
 * was no page and no route.
 *
 * What this service returns is **code-defined copy**, not a reflection of live infrastructure.
 * That is the deliberate line between this slice and the status page (x159): a trust page states
 * the controls the product is built to and the third parties it relies on, which are facts about
 * the design and change with a release; a status page states whether those systems are up right
 * now, which changes by the minute and needs a data source. Mixing the two would let a static
 * string imply a live "all systems operational" it cannot know — the same class of false
 * security statement `D15` recorded for the recovery screen. So there is no live status here, no
 * database, and nothing tenant- or session-specific: the read is deterministic and identical for
 * everyone, which is exactly what a public trust page should be.
 *
 * The content is frozen so a handler cannot hand a caller a reference it could mutate, and so a
 * reviewer reading the route sees a value, not a builder.
 */

/** One group of related controls — e.g. access, encryption, resilience. */
export interface TrustControlSection {
  /** Stable id for the section, used as the DOM anchor and React key on the screen. */
  readonly id: string;
  readonly title: string;
  /** One sentence naming what the section is about, above the individual controls. */
  readonly summary: string;
  /** The controls themselves, each a short statement of a practice the product follows. */
  readonly controls: readonly string[];
}

/** A third party that processes data on TManage's behalf — named so a reviewer can assess it. */
export interface TrustSubprocessor {
  readonly name: string;
  /** What the subprocessor is used for, in plain terms. */
  readonly purpose: string;
  /** Where the processing happens, at region granularity. */
  readonly location: string;
}

/**
 * The public trust view. Deterministic, org-less, session-less.
 *
 * Paired `Exact` with the web's `PublicTrustView` (`apps/web/src/lib/api/public-trust.ts`) in
 * `e2e/contracts/api-web-shapes.ts`, so the copy the screen renders and the copy the API serves
 * cannot drift into two different security postures.
 */
export interface PublicTrustView {
  /** The control sections, in the order the page presents them. */
  readonly controls: readonly TrustControlSection[];
  /** How customer data is handled, as short statements — retention, isolation, portability. */
  readonly dataHandling: readonly string[];
  /** The subprocessor list, in stable order. Never empty. */
  readonly subprocessors: readonly TrustSubprocessor[];
  /** Compliance and posture statements — honest about what is in place and what is not. */
  readonly compliance: readonly string[];
  /**
   * Where the live status page lives (x159). A path, not a live status: this page links to
   * status, it does not report it.
   */
  readonly statusPath: string;
}

const TRUST_CONTENT: PublicTrustView = Object.freeze({
  controls: Object.freeze([
    Object.freeze({
      id: 'access',
      title: 'Access control',
      summary:
        'Every request is authenticated, bound to one organization, and checked against a role ceiling.',
      controls: Object.freeze([
        'Sessions are short-lived access tokens with server-side revocation; refresh tokens rotate and reuse is detected.',
        'Multi-factor enrolment is supported for accounts that hold elevated roles.',
        'Authorization is enforced per request in a fixed pipeline — authenticate, then organization, then capability — so a new route is protected by default.',
        'Access is scoped to the caller’s organization; cross-tenant reads are refused before any handler runs.',
      ]),
    }),
    Object.freeze({
      id: 'encryption',
      title: 'Encryption',
      summary: 'Data is encrypted in transit, and secrets never travel in URLs or logs.',
      controls: Object.freeze([
        'All traffic is served over TLS.',
        'Credentials, invitation and recovery tokens are carried in request bodies, never in query strings.',
        'Telemetry and audit records redact user-supplied payloads so an operator view cannot surface a customer’s content.',
      ]),
    }),
    Object.freeze({
      id: 'resilience',
      title: 'Resilience and operations',
      summary:
        'Changes are reviewed, migrations are reversible, and every governed action is recorded.',
      controls: Object.freeze([
        'Schema changes ship as ordered, forward-only migrations applied by a single migrator.',
        'Governed actions are written to an append-only audit log with a named actor and a result.',
        'Background work is delivered through an outbox so a failed delivery is retried, not lost.',
      ]),
    }),
    Object.freeze({
      id: 'data-protection',
      title: 'Data protection',
      summary: 'Customer data is isolated per organization and exportable on request.',
      controls: Object.freeze([
        'Each organization’s data is isolated; database roles are granted least privilege.',
        'Uploaded files are stored in object storage with per-tenant prefixes.',
        'An organization can export its own audit trail and records.',
      ]),
    }),
  ]),
  dataHandling: Object.freeze([
    'Customer data belongs to the customer’s organization and is never shared between organizations.',
    'Data is retained for the life of the account and removed on request when an organization is closed.',
    'Only the subprocessors listed below handle customer data, and only for the stated purpose.',
  ]),
  subprocessors: Object.freeze([
    Object.freeze({
      name: 'Hostinger',
      purpose: 'Application and database hosting',
      location: 'European Union',
    }),
    Object.freeze({
      name: 'Object storage (S3-compatible)',
      purpose: 'Uploaded file storage',
      location: 'European Union',
    }),
    Object.freeze({
      name: 'SMTP email provider',
      purpose: 'Transactional email delivery',
      location: 'European Union',
    }),
  ]),
  compliance: Object.freeze([
    'TManage is built to the practices described on this page; independent third-party certification is on the roadmap and not yet claimed.',
    'Security questions and vulnerability reports are welcome at the contact address on the site.',
  ]),
  statusPath: '/status',
});

/**
 * Serves the frozen trust content. No dependencies, because the content depends on nothing —
 * not the database, not the caller, not the organization.
 */
export class TrustContentService {
  /** The public trust view. The same frozen value every time. */
  getTrust(): PublicTrustView {
    return TRUST_CONTENT;
  }
}

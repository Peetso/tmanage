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

import { LEGAL_DOCUMENTS } from '@tmanage/domain';

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
 * The two frozen legal documents, keyed by the allowlisted doc id. The copy lives in
 * `@tmanage/domain` so the web can render it on the server too (a crawler that runs no JavaScript —
 * Google's OAuth brand review — must find the whole policy in the HTML); this endpoint serves the
 * same object, so the two cannot drift.
 */
const LEGAL: Readonly<Record<LegalDoc, PublicLegalView>> = LEGAL_DOCUMENTS;

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

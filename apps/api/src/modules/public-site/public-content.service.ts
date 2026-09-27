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
 * The public marketing content. No tenant, no database, no session — the payload is the same for
 * everyone and is served through the `@Public()` door on the controller.
 */
export class PublicContentService {
  /** The marketing home content. Deterministic: the same frozen payload every call. */
  home(): PublicHomeView {
    return HOME;
  }
}

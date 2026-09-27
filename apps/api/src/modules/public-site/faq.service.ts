/**
 * Public & trust site (module 1) — the public FAQ content (x186).
 *
 * The one job of this service is to answer the public FAQ page as a deterministic, code-defined
 * payload: grouped question/answer entries that are the same for every visitor, authenticated or
 * not. There is no database read and no tenant — a per-tenant round-trip would be both wrong and a
 * needless dependency — so the copy is frozen and a caller cannot mutate the shared instance.
 *
 * Why a service rather than a constant inlined in the controller: the controller stays a thin HTTP
 * adapter (ADR-0001 layer boundaries), the payload is unit-testable on its own, and a later slice
 * that wants the same copy on a second surface injects this rather than copying the strings. It
 * sits beside the other public slices, each in its own files so they stay file-disjoint.
 */

/** DI token for the FAQ-content service (ADR-0003: every provider carries an explicit token). */
export const PUBLIC_FAQ_SERVICE = Symbol('tmanage.public-faq.service');

/**
 * The public FAQ view — grouped accordion content. Nested shapes are inlined rather than exported
 * so the API↔web pairing is the single `PublicFaqView` projection (contracts-check enumerates every
 * exported `…View`, and every web `export interface`).
 */
export interface PublicFaqView {
  readonly groups: readonly {
    readonly id: string;
    readonly title: string;
    readonly items: readonly {
      readonly id: string;
      readonly question: string;
      readonly answer: string;
    }[];
  }[];
}

/**
 * The single, frozen payload. `as const` plus `Object.freeze` on every level means neither the
 * service nor any consumer can mutate what every request shares.
 */
const FAQ: PublicFaqView = Object.freeze({
  groups: Object.freeze([
    Object.freeze({
      id: 'getting-started',
      title: 'Getting started',
      items: Object.freeze([
        Object.freeze({
          id: 'what-is-tmanage',
          question: 'What is TManage?',
          answer:
            'TManage keeps client projects, approvals, and the client portal in one place, so the next step is always visible and nobody has to ask where things stand.',
        }),
        Object.freeze({
          id: 'how-do-i-start',
          question: 'How do I get started?',
          answer:
            'Create an organization, invite your team, and add your first project. The onboarding checklist walks you through connecting a client portal and publishing your first update.',
        }),
      ]),
    }),
    Object.freeze({
      id: 'client-portal',
      title: 'The client portal',
      items: Object.freeze([
        Object.freeze({
          id: 'what-can-clients-see',
          question: 'What can clients see?',
          answer:
            'Each client sees only what you share: deliverables, approvals, and updates scoped to their own projects. Internal work, other clients, and your team’s private notes are never exposed.',
        }),
        Object.freeze({
          id: 'do-clients-need-accounts',
          question: 'Do clients need an account?',
          answer:
            'Clients sign in to a portal scoped to exactly what they are allowed to see. There is nothing to install, and access is revoked the moment you remove them.',
        }),
      ]),
    }),
    Object.freeze({
      id: 'security-and-data',
      title: 'Security & data',
      items: Object.freeze([
        Object.freeze({
          id: 'where-is-data-stored',
          question: 'Where is my data stored?',
          answer:
            'Customer data belongs to the customer and is isolated per organization. The security page describes the controls the product is built to and the third parties it relies on.',
        }),
        Object.freeze({
          id: 'can-i-export',
          question: 'Can I export my data?',
          answer:
            'Yes. Workload, delivery health, and adoption are read straight from the work itself, and your records can be exported so the numbers are the record rather than a snapshot.',
        }),
      ]),
    }),
  ]),
}) as PublicFaqView;

/**
 * The public FAQ content. No tenant, no database, no session — the payload is the same for everyone
 * and is served through the `@Public()` door on the controller.
 */
export class FaqContentService {
  /** The FAQ content. Deterministic: the same frozen payload every call. */
  getFaq(): PublicFaqView {
    return FAQ;
  }
}

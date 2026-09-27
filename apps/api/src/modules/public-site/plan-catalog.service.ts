/**
 * FEAT · module 1 Public site (x157). The public plan catalog.
 *
 * `38-MODULE-MAP` §Public site (pricing), audit rank #1 (Public site Missing — no pricing page).
 * This is the display half of pricing only: a static, deterministic catalog of the plan tiers the
 * marketing site shows an unauthenticated visitor. Real payment, card storage and charging are
 * **Needs-Peter** (NEXT-SCOPES-13, recommended Stripe test-mode first) and land nowhere here — this
 * service returns copy and numbers, never a checkout.
 *
 * Static in code rather than a table on purpose: there is no per-tenant plan data (the reader has no
 * tenant — the route is `@Public()`), the catalog is the same for everyone, and a row that only ever
 * holds seeded constants would be a migration and a tenant question for no gain. So there is **no new
 * table** and nothing to register in the schema/tenant-guard/grant/migrator quartet.
 */

/**
 * One plan tier as the public pricing page reads it.
 *
 * Paired `Exact` with the web's `PublicPlanView` (`apps/web/src/lib/api/public-plans.ts`) in
 * `e2e/contracts/api-web-shapes.ts`. It carries display copy and a price, never anything
 * tenant-scoped or personal — the endpoint has no principal to scope to.
 */
export interface PublicPlanView {
  /** Stable tier id, e.g. `team`. Carried by the sign-up CTA; never a database key. */
  readonly id: string;
  /** The tier's display name, e.g. `Team`. */
  readonly name: string;
  /** One line under the name. */
  readonly tagline: string;
  /** The per-member monthly price in minor units. `0` is a genuinely free tier, never "call us". */
  readonly monthlyPriceCents: number;
  /** ISO-4217, lowercased — the unit `monthlyPriceCents` is counted in. */
  readonly currency: string;
  /** A human-readable seat rule, e.g. `Up to 5 members`. Always present, never empty. */
  readonly seatRule: string;
  /** Exactly one tier is the recommended one, rendered as the highlighted card. */
  readonly featured: boolean;
  /** The tier's feature bullets, in display order. */
  readonly features: readonly string[];
}

/**
 * The catalog, frozen so a caller cannot mutate the shared constant, and in the order the page
 * renders it (cheapest first, `featured` in the middle). Deterministic: the same array every call.
 */
const PLAN_CATALOG: readonly PublicPlanView[] = Object.freeze([
  {
    id: 'free',
    name: 'Free',
    tagline: 'For a first project and a small team finding its feet.',
    monthlyPriceCents: 0,
    currency: 'usd',
    seatRule: 'Up to 3 members',
    featured: false,
    features: Object.freeze([
      '1 workspace',
      'Work items, requests and documents',
      'Client portal for 1 project',
      'Community support',
    ]),
  },
  {
    id: 'team',
    name: 'Team',
    tagline: 'For a growing team running client work end to end.',
    monthlyPriceCents: 1200,
    currency: 'usd',
    seatRule: 'Per member, billed monthly',
    featured: false,
    features: Object.freeze([
      'Everything in Free',
      'Unlimited workspaces and projects',
      'Meetings, decisions and objectives',
      'Insights and portfolio roll-ups',
      'Email support',
    ]),
  },
  {
    id: 'business',
    name: 'Business',
    tagline: 'For an organization that needs control and an audit trail.',
    monthlyPriceCents: 2400,
    currency: 'usd',
    seatRule: 'Per member, billed monthly',
    featured: true,
    features: Object.freeze([
      'Everything in Team',
      'Custom roles and access policies',
      'Full audit log and export',
      'Usage quotas and reconciliation',
      'Priority support',
    ]),
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    tagline: 'For scale, procurement and a security review.',
    monthlyPriceCents: 4800,
    currency: 'usd',
    seatRule: 'Volume pricing for 50+ members',
    featured: false,
    features: Object.freeze([
      'Everything in Business',
      'SSO and enterprise identity',
      'Data residency and retention controls',
      'A named contact and an SLA',
    ]),
  },
]);

/**
 * The plan-catalog read. Stateless — the catalog is a module constant — so a single instance is
 * shared by the module; it holds no connection and touches no tenant.
 */
export class PlanCatalogService {
  /** The full catalog, in stable display order. The same reference every call. */
  list(): readonly PublicPlanView[] {
    return PLAN_CATALOG;
  }
}

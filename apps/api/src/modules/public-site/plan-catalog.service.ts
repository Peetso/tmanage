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
  /** Stable tier id, e.g. `studio`. Carried by the sign-up CTA; never a database key. */
  readonly id: string;
  /** The tier's display name, e.g. `Studio`. */
  readonly name: string;
  /** One line under the name. */
  readonly tagline: string;
  /**
   * The flat monthly price for the whole team in minor units. `0` is the free tier, and also
   * Enterprise, which is quoted per contract (its tagline says "Custom").
   */
  readonly monthlyPriceCents: number;
  /** ISO-4217, lowercased — the unit `monthlyPriceCents` is counted in. */
  readonly currency: string;
  /** A human-readable seat rule, e.g. `Flat price for the whole team`. Always present. */
  readonly seatRule: string;
  /** Exactly one tier is the recommended one, rendered as the highlighted card. */
  readonly featured: boolean;
  /** The tier's feature bullets, in display order. */
  readonly features: readonly string[];
}

/** Every tier is one flat monthly price for the whole team, never a per-member price. */
const FLAT_SEAT_RULE = 'Flat price for the whole team';

/**
 * The catalog, frozen so a caller cannot mutate the shared constant, in the order the page renders
 * it (cheapest first, Studio `featured` in the middle, Enterprise last). The same five flat plans
 * the website `/pricing` page draws (approved Figma section 376:2087). Enterprise is quoted per
 * contract, so its `monthlyPriceCents` is `0` with "Custom" in its tagline — the one tier where `0`
 * does not mean free. Deterministic: the same array every call.
 */
const PLAN_CATALOG: readonly PublicPlanView[] = Object.freeze([
  {
    id: 'free',
    name: 'Free',
    tagline: 'For a small team trying TManage on real client work.',
    monthlyPriceCents: 0,
    currency: 'usd',
    seatRule: FLAT_SEAT_RULE,
    featured: false,
    features: Object.freeze([
      'Up to 3 internal people',
      '3 active projects',
      'Unlimited clients, always free',
      'Work, chat and calendar',
    ]),
  },
  {
    id: 'starter',
    name: 'Starter',
    tagline: 'For small teams moving their projects off spreadsheets.',
    monthlyPriceCents: 1900,
    currency: 'usd',
    seatRule: FLAT_SEAT_RULE,
    featured: false,
    features: Object.freeze([
      'Up to 10 internal people',
      'Unlimited projects',
      'Requests and approvals',
      'Branded client portal',
    ]),
  },
  {
    id: 'studio',
    name: 'Studio',
    tagline: 'For agencies running many clients and projects at once.',
    monthlyPriceCents: 4900,
    currency: 'usd',
    seatRule: FLAT_SEAT_RULE,
    featured: true,
    features: Object.freeze([
      'Unlimited internal people',
      'Docs and decisions',
      'Workload insights',
      'Automations',
    ]),
  },
  {
    id: 'business',
    name: 'Business',
    tagline: 'For firms that need control, roles and reporting across teams.',
    monthlyPriceCents: 8900,
    currency: 'usd',
    seatRule: FLAT_SEAT_RULE,
    featured: false,
    features: Object.freeze([
      'Unlimited internal people',
      'SSO and security controls',
      'Admin console and roles',
      'Audit log and priority support',
    ]),
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    tagline: 'Custom: for large teams with security reviews and contracts.',
    monthlyPriceCents: 0,
    currency: 'usd',
    seatRule: FLAT_SEAT_RULE,
    featured: false,
    features: Object.freeze([
      'Everything in Business',
      'SCIM and data residency',
      'Contract and invoicing',
      'Named success lead',
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

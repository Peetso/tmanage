import type { ApiClient } from './client';

/**
 * The public plan catalog — FEAT · module 1 Public site (x157).
 *
 * - **`GET /v1/public/site/plans`** returns the static tiers the pricing page renders. It is a
 *   `@Public()` endpoint, so the request carries no session and no CSRF token: `authentication: 'none'`
 *   below is what tells the client not to attach the access cookie or attempt a refresh on a 401.
 *
 * The response is display copy and prices only — there is no tenant and nothing personal in it, and
 * this module posts nothing. Real payment and checkout are a later, Needs-Peter concern; the pricing
 * page's call to action forwards only the chosen tier id to the sign-in flow.
 */

export interface PublicPlanView {
  /** Stable tier id, e.g. `team`. Carried by the sign-up CTA. */
  readonly id: string;
  /** The tier's display name, e.g. `Team`. */
  readonly name: string;
  /** One line under the name. */
  readonly tagline: string;
  /** The per-member monthly price in minor units. `0` is a genuinely free tier. */
  readonly monthlyPriceCents: number;
  /** ISO-4217, lowercased — the unit `monthlyPriceCents` is counted in. */
  readonly currency: string;
  /** A human-readable seat rule, e.g. `Up to 5 members`. Never empty. */
  readonly seatRule: string;
  /** Exactly one tier is the recommended one, rendered as the highlighted card. */
  readonly featured: boolean;
  /** The tier's feature bullets, in display order. */
  readonly features: readonly string[];
}

export async function listPublicPlans(client: ApiClient): Promise<readonly PublicPlanView[]> {
  const { data } = await client.request<{ plans: readonly PublicPlanView[] }>({
    path: '/v1/public/site/plans',
    authentication: 'none',
  });
  return data.plans;
}

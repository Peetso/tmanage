import type { ApiClient } from './client';

/**
 * The organization subscription endpoints — Billing / module 19 (x177), behind the subscription
 * screen (`38-…` §Billing).
 *
 * Hand-written for the boundary reason `errors.ts` gives, and paired with the API projection in the
 * `e2e/contracts` shape check so the two shapes cannot drift.
 *
 * Both routes are gated on the server by `org.manage` — owners only — so a member who reaches this
 * client gets the ordinary 403 the shared client turns into an error; there is no organization-id
 * argument here, because the tenant is the slug in the path resolved against the caller's membership,
 * never a value the caller supplies. A plan change records an intent (`pending_change`); no payment
 * is executed here.
 */

/** The plan's status. `pending_change` = requested, not yet charged/activated. Mirrors the API. */
export type SubscriptionStatus = 'active' | 'pending_change';

export interface SubscriptionView {
  readonly planId: string;
  readonly status: SubscriptionStatus;
  /** Null on the free/base tier and until a provider sets the billing period. */
  readonly currentPeriodEnd: string | null;
}

export async function fetchSubscription(
  client: ApiClient,
  organizationSlug: string,
): Promise<SubscriptionView> {
  const { data } = await client.request<SubscriptionView>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/billing/subscription`,
  });
  return data;
}

export async function requestPlanChange(
  client: ApiClient,
  organizationSlug: string,
  planId: string,
): Promise<SubscriptionView> {
  const { data } = await client.request<SubscriptionView>({
    method: 'POST',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/billing/subscription/change`,
    body: { planId },
  });
  return data;
}

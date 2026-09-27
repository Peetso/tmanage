import type { ApiClient } from './client';

/**
 * Billing credits — Billing module 19 (x226).
 *
 * This module wraps the credits API: list the organization's manual credit / adjustment ledger with a
 * running balance, and post a new credit. The one exported response shape is {@link BillingCreditView},
 * paired Exact with the API's `BillingCreditView` in the contracts gate so the two cannot drift.
 *
 * Every read and write is gated on the server by `org.manage` — owners only — so a member who reaches
 * this client gets the ordinary 403 the shared client turns into an error; there is no organization-id
 * argument here, because the tenant is the slug in the path resolved against the caller's membership,
 * never a value the caller supplies. This is a bookkeeping ledger: posting a credit records a row, it
 * does not move money or settle an invoice, and a posted credit cannot be edited or removed.
 */

/**
 * One posted credit — paired Exact with the API's `BillingCreditView`. `organizationId` is absent on
 * both sides: the wire projection never echoes the tenant id. `amount` is signed integer minor units
 * (positive is a credit, negative an adjustment).
 */
export interface BillingCreditView {
  readonly id: string;
  readonly amount: number;
  readonly reason: string;
  readonly createdBy: string;
  readonly createdAt: string;
}

/** The fields a post sends. Request-side (suffix `Input`), so the contracts gate ignores it. */
export interface PostBillingCreditInput {
  readonly amount: number;
  readonly reason: string;
}

function base(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/billing/credits`;
}

/**
 * List the organization's credits newest-first with a running balance. The envelope is inline (not a
 * named interface) so the contracts gate pairs the one element shape, {@link BillingCreditView}.
 */
export async function listBillingCredits(
  client: ApiClient,
  organizationSlug: string,
): Promise<{ readonly credits: readonly BillingCreditView[]; readonly balance: number }> {
  const { data } = await client.request<{
    readonly credits: readonly BillingCreditView[];
    readonly balance: number;
  }>({
    path: base(organizationSlug),
  });
  return data;
}

/** Post a credit / adjustment. */
export async function postBillingCredit(
  client: ApiClient,
  organizationSlug: string,
  input: PostBillingCreditInput,
): Promise<BillingCreditView> {
  const { data } = await client.request<BillingCreditView>({
    method: 'POST',
    path: base(organizationSlug),
    body: input,
  });
  return data;
}

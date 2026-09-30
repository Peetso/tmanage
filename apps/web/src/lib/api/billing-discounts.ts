import type { ApiClient } from './client';

/**
 * Billing discounts — Billing & plan management, module 19 (x330).
 *
 * This module wraps the discounts API: list the organization's discount / adjustment register (each
 * record marked active or expired), record a new discount, and remove one. The one exported response
 * shape is {@link BillingDiscountView}, paired Exact with the API's `BillingDiscountView` in the
 * contracts gate so the two cannot drift.
 *
 * Every read and write is gated on the server by `org.manage` — owners only — so a member who reaches
 * this client gets the ordinary 403 the shared client turns into an error; there is no organization-id
 * argument here, because the tenant is the slug in the path resolved against the caller's membership,
 * never a value the caller supplies. This is a bookkeeping register: recording a discount stores a row,
 * it does not move money or settle a charge, and a discount is created and removed, never edited.
 */

/**
 * One discount — paired Exact with the API's `BillingDiscountView`. `organizationId` is absent on both
 * sides: the wire projection never echoes the tenant id. `active` is computed by the API against its
 * process clock. `amount` is a whole percentage 0..100 for `percent`, or a non-negative integer minor-
 * units amount for `fixed`.
 */
export interface BillingDiscountView {
  readonly id: string;
  readonly label: string;
  readonly kind: 'percent' | 'fixed';
  readonly amount: number;
  readonly expiresOn: string | null;
  readonly active: boolean;
  readonly createdBy: string;
  readonly createdAt: string;
}

/** The fields a create sends. Request-side (suffix `Input`), so the contracts gate ignores it. */
export interface CreateBillingDiscountInput {
  readonly label: string;
  readonly kind: 'percent' | 'fixed';
  readonly amount: number;
  readonly expiresOn: string | null;
}

function base(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/billing/discounts`;
}

/**
 * List the organization's discounts newest-first, each marked active or expired. The envelope is inline
 * (not a named interface) so the contracts gate pairs the one element shape, {@link BillingDiscountView}.
 */
export async function listBillingDiscounts(
  client: ApiClient,
  organizationSlug: string,
): Promise<{ readonly discounts: readonly BillingDiscountView[] }> {
  const { data } = await client.request<{ readonly discounts: readonly BillingDiscountView[] }>({
    path: base(organizationSlug),
  });
  return data;
}

/** Record a discount / adjustment. */
export async function createBillingDiscount(
  client: ApiClient,
  organizationSlug: string,
  input: CreateBillingDiscountInput,
): Promise<BillingDiscountView> {
  const { data } = await client.request<BillingDiscountView>({
    method: 'POST',
    path: base(organizationSlug),
    body: input,
  });
  return data;
}

/** Remove a discount, tenant-scoped. A cross-tenant or absent id is a 404 on the server. */
export async function deleteBillingDiscount(
  client: ApiClient,
  organizationSlug: string,
  discountId: string,
): Promise<void> {
  await client.request<void>({
    method: 'DELETE',
    path: `${base(organizationSlug)}/${encodeURIComponent(discountId)}`,
  });
}

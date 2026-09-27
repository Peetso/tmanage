import type { ApiClient } from './client';

/**
 * The purchase-order (PO) endpoints — Billing & entitlements (module 19, x282), behind the
 * purchase-orders screen. A billing admin records the finance-issued PO references so a later invoice
 * can cite one.
 *
 * Hand-written for the boundary reason `errors.ts` gives. Every route is gated on the server by
 * `org.manage` — owners only — so a member who reaches this client gets the ordinary 403 the shared
 * client turns into an error. There is no organization-id argument: the tenant is the slug in the path
 * resolved against the caller's membership, never a value the caller supplies. Only non-secret
 * metadata is carried — there is no card or bank field, by design; a PO reference is a record, never a
 * payment.
 */

/** One PO reference — paired Exact with the API's `PurchaseOrderView`. `amount` is in the smallest
 * unit of `currency`, integer, never a float. */
export interface PurchaseOrderSummary {
  readonly id: string;
  readonly poNumber: string;
  readonly amountMinor: number | null;
  readonly currency: string | null;
  readonly note: string | null;
  readonly status: 'open' | 'closed';
  readonly createdAt: string;
}

/** What the create endpoint accepts. `amount` is a non-negative integer in the smallest currency unit. */
export interface CreatePurchaseOrderInput {
  readonly poNumber: string;
  readonly amount?: number;
  readonly currency?: string;
  readonly note?: string;
}

function base(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/billing/purchase-orders`;
}

export async function listPurchaseOrders(
  client: ApiClient,
  organizationSlug: string,
): Promise<readonly PurchaseOrderSummary[]> {
  const { data } = await client.request<{ purchaseOrders: readonly PurchaseOrderSummary[] }>({
    path: base(organizationSlug),
  });
  return data.purchaseOrders;
}

export async function createPurchaseOrder(
  client: ApiClient,
  organizationSlug: string,
  input: CreatePurchaseOrderInput,
): Promise<PurchaseOrderSummary> {
  const { data } = await client.request<PurchaseOrderSummary>({
    method: 'POST',
    path: base(organizationSlug),
    body: input,
  });
  return data;
}

export async function closePurchaseOrder(
  client: ApiClient,
  organizationSlug: string,
  id: string,
): Promise<PurchaseOrderSummary> {
  const { data } = await client.request<PurchaseOrderSummary>({
    method: 'PUT',
    path: `${base(organizationSlug)}/${encodeURIComponent(id)}/close`,
  });
  return data;
}

export async function deletePurchaseOrder(
  client: ApiClient,
  organizationSlug: string,
  id: string,
): Promise<void> {
  await client.request<void>({
    method: 'DELETE',
    path: `${base(organizationSlug)}/${encodeURIComponent(id)}`,
  });
}

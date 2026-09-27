import type { ApiClient } from './client';

/**
 * Billing seats — Billing module 19 (x178).
 *
 * This module wraps the seat-management API: list the organization's active seats, assign a seat to a
 * membership, and reclaim (release) a seat. The one exported response shape is {@link BillingSeat},
 * paired Exact with the API's `BillingSeatView` in the contracts gate so the two cannot drift.
 *
 * Every read and write is gated on the server by `org.manage` — owners only — so a member who reaches
 * this client gets the ordinary 403 the shared client turns into an error; there is no organization-id
 * argument here, because the tenant is the slug in the path resolved against the caller's membership,
 * never a value the caller supplies.
 */

/**
 * One billing seat — paired Exact with the API's `BillingSeatView`. `organizationId` is absent on
 * both sides: the wire projection never echoes the tenant id.
 */
export interface BillingSeat {
  readonly id: string;
  readonly membershipId: string;
  readonly assignedAt: string;
  readonly releasedAt: string | null;
}

/** The fields an assign sends. Request-side (suffix `Input`), so the contracts gate ignores it. */
export interface AssignSeatInput {
  readonly membershipId: string;
}

function base(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/billing/seats`;
}

/**
 * List the organization's active seats and their count. The envelope is inline (not a named
 * interface) so the contracts gate pairs the one element shape, {@link BillingSeat}.
 */
export async function listBillingSeats(
  client: ApiClient,
  organizationSlug: string,
): Promise<{ readonly seats: readonly BillingSeat[]; readonly activeCount: number }> {
  const { data } = await client.request<{
    readonly seats: readonly BillingSeat[];
    readonly activeCount: number;
  }>({ path: base(organizationSlug) });
  return data;
}

/** Assign a seat to a membership. */
export async function assignBillingSeat(
  client: ApiClient,
  organizationSlug: string,
  input: AssignSeatInput,
): Promise<BillingSeat> {
  const { data } = await client.request<BillingSeat>({
    method: 'POST',
    path: base(organizationSlug),
    body: input,
  });
  return data;
}

/** Reclaim (release) a seat. */
export async function releaseBillingSeat(
  client: ApiClient,
  organizationSlug: string,
  seatId: string,
): Promise<BillingSeat> {
  const { data } = await client.request<BillingSeat>({
    method: 'DELETE',
    path: `${base(organizationSlug)}/${encodeURIComponent(seatId)}`,
  });
  return data;
}

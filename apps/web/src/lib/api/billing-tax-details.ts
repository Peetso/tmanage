import type { ApiClient } from './client';

/**
 * Billing tax / legal-entity details — Billing module 19 (x283).
 *
 * This module wraps the tax-details API: read the organization's legal invoicing entity and upsert it.
 * The one exported response shape is {@link TaxDetailsView}, paired Exact with the API's
 * `TaxDetailsView` in the contracts gate so the two shapes cannot drift.
 *
 * The read and the update are gated on the server by `org.manage` — owners only — so a member who
 * reaches this client gets the ordinary 403 the shared client turns into an error. There is no
 * organization-id argument: the tenant is the slug in the path resolved against the caller's
 * membership, never a value the caller supplies. Only non-secret legal/tax metadata is carried here —
 * there is no card or bank field, by design; payment instruments are held by the payment provider.
 */

/**
 * The organization's tax / legal-entity details — paired Exact with the API's `TaxDetailsView`.
 * `organizationId` is absent on both sides: the wire projection never echoes the tenant id. Every field
 * is null until the row is first saved.
 */
export interface TaxDetailsView {
  readonly legalName: string | null;
  readonly taxId: string | null;
  readonly registrationNo: string | null;
  readonly taxCountry: string | null;
  readonly updatedAt: string | null;
}

/**
 * The fields an update sends. Request-side (suffix `Input`), so the contracts gate ignores it.
 * `legalName` and `taxCountry` are required by the server; the ids are optional and clear on blank.
 */
export interface UpdateTaxDetailsInput {
  readonly legalName: string;
  readonly taxId?: string | null;
  readonly registrationNo?: string | null;
  readonly taxCountry: string;
}

function path(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/billing/tax-details`;
}

/** Read the organization's tax details (defaults when none has been saved). */
export async function fetchTaxDetails(
  client: ApiClient,
  organizationSlug: string,
): Promise<TaxDetailsView> {
  const { data } = await client.request<TaxDetailsView>({ path: path(organizationSlug) });
  return data;
}

/** Create or replace the organization's tax details. */
export async function updateTaxDetails(
  client: ApiClient,
  organizationSlug: string,
  input: UpdateTaxDetailsInput,
): Promise<TaxDetailsView> {
  const { data } = await client.request<TaxDetailsView>({
    method: 'PUT',
    path: path(organizationSlug),
    body: input,
  });
  return data;
}

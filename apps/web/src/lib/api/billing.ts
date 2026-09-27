import type { ApiClient } from './client';

/**
 * The billing-profile endpoints — module 19 (x180), behind the billing-settings screen (audit #10).
 *
 * Hand-written for the boundary reason `errors.ts` gives, and paired with the API projection in the
 * `e2e/contracts` shape check so the two shapes cannot drift.
 *
 * The read and the update are gated on the server by `org.manage` — owners only — so a member who
 * reaches this client gets the ordinary 403 the shared client turns into an error. There is no
 * organization-id argument: the tenant is the slug in the path resolved against the caller's
 * membership, never a value the caller supplies. Only non-secret metadata is carried here — there is
 * no card or bank field, by design; payment instruments are held by the payment provider.
 */

/** A billing address. A `type` alias (an object literal), so the contracts gate does not enumerate it
 * as a projection of its own — it travels inside {@link BillingProfileView}. Mirrors the API's
 * `BillingAddress`. */
export type BillingAddress = {
  readonly line1: string | null;
  readonly line2: string | null;
  readonly city: string | null;
  readonly region: string | null;
  readonly postalCode: string | null;
  readonly country: string | null;
};

/**
 * One billing profile — paired Exact with the API's `BillingProfileView`. `organizationId` is absent
 * on both sides: the wire projection never echoes the tenant id. `updatedAt` is null until the profile
 * is first saved.
 */
export interface BillingProfileView {
  readonly billingEmail: string | null;
  readonly companyName: string | null;
  readonly taxId: string | null;
  readonly address: BillingAddress;
  readonly updatedAt: string | null;
}

/**
 * The fields an update sends. Request-side (suffix `Input`), so the contracts gate ignores it. Every
 * field is optional; an omitted or null field clears that value.
 */
export interface UpdateBillingProfileInput {
  readonly billingEmail?: string | null;
  readonly companyName?: string | null;
  readonly taxId?: string | null;
  readonly address?: {
    readonly line1?: string | null;
    readonly line2?: string | null;
    readonly city?: string | null;
    readonly region?: string | null;
    readonly postalCode?: string | null;
    readonly country?: string | null;
  };
}

function path(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/billing/profile`;
}

/** Read the organization's billing profile (defaults when none has been saved). */
export async function fetchBillingProfile(
  client: ApiClient,
  organizationSlug: string,
): Promise<BillingProfileView> {
  const { data } = await client.request<BillingProfileView>({ path: path(organizationSlug) });
  return data;
}

/** Create or replace the organization's billing profile. */
export async function updateBillingProfile(
  client: ApiClient,
  organizationSlug: string,
  input: UpdateBillingProfileInput,
): Promise<BillingProfileView> {
  const { data } = await client.request<BillingProfileView>({
    method: 'PUT',
    path: path(organizationSlug),
    body: input,
  });
  return data;
}

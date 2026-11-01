import type { ApiClient } from './client';

/**
 * The organization usage endpoint — USAGE-001 slice 5, behind the billing screen (`49-…` §8).
 *
 * Hand-written for the boundary reason `errors.ts` gives, and paired with the API projection in
 * the `e2e/contracts` shape check so the two shapes cannot drift.
 *
 * The read is gated on the server by `org.manage` — owners only — so a member who reaches this
 * client gets the ordinary 403 the shared client turns into an error; there is no organization-id
 * argument here, because the tenant is the slug in the path resolved against the caller's
 * membership, never a value the caller supplies.
 */

/** No screen consumes this yet: the billing/usage screen is a follow-up (see x64-report). */
export interface OrganizationUsage {
  readonly used: number;
  /** Of `used`, the bytes of preview images the viewer made — they count against the quota. */
  readonly previews: number;
  readonly reserved: number;
  readonly quota: number;
  readonly unit: 'bytes';
  /** Null until the reconciler first checks the counter against its ledger (slice 3). */
  readonly reconciledAt: string | null;
}

export async function fetchOrganizationUsage(
  client: ApiClient,
  organizationSlug: string,
): Promise<OrganizationUsage> {
  const { data } = await client.request<OrganizationUsage>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/usage`,
  });
  return data;
}

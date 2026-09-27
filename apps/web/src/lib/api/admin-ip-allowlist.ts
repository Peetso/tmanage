import type { ApiClient } from './client';

/**
 * Organization IP allowlist — Administration module 18 (x277).
 *
 * Wraps the admin IP-allowlist API: list the organization's advisory allowed IP/CIDR ranges, add one,
 * and remove one. The one exported response shape is {@link IpAllowlistEntryView}, paired Exact with
 * the API's `IpAllowlistEntryView` in the contracts gate so the two cannot drift.
 *
 * Every read and write is gated on the server by `org.security.manage` — a security admin — so a member
 * who reaches this client gets the ordinary 403 the shared client turns into an error; there is no
 * organization-id argument here, because the tenant is the slug in the path resolved against the
 * caller's membership, never a value the caller supplies. The list is advisory only — this surface
 * records ranges and does not enforce them at request time.
 */

/**
 * One allowlist entry — paired Exact with the API's `IpAllowlistEntryView`. `organizationId` is absent
 * on both sides: the wire projection never echoes the tenant id.
 */
export interface IpAllowlistEntryView {
  readonly id: string;
  readonly cidr: string;
  readonly label: string | null;
  readonly createdAt: string;
}

/** The fields an add sends. Request-side (suffix `Input`), so the contracts gate ignores it. */
export interface AddIpAllowlistEntryInput {
  readonly cidr: string;
  readonly label?: string | null;
}

function base(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/admin/ip-allowlist`;
}

/**
 * List the organization's allowlist entries. The envelope is inline (not a named interface) so the
 * contracts gate pairs the one element shape, {@link IpAllowlistEntryView}.
 */
export async function listIpAllowlist(
  client: ApiClient,
  organizationSlug: string,
): Promise<{ readonly entries: readonly IpAllowlistEntryView[] }> {
  const { data } = await client.request<{ readonly entries: readonly IpAllowlistEntryView[] }>({
    path: base(organizationSlug),
  });
  return data;
}

/** Add an allowlist entry. */
export async function addIpAllowlistEntry(
  client: ApiClient,
  organizationSlug: string,
  input: AddIpAllowlistEntryInput,
): Promise<IpAllowlistEntryView> {
  const { data } = await client.request<IpAllowlistEntryView>({
    method: 'POST',
    path: base(organizationSlug),
    body: input,
  });
  return data;
}

/** Remove an allowlist entry. The API answers 204 with no body. */
export async function removeIpAllowlistEntry(
  client: ApiClient,
  organizationSlug: string,
  entryId: string,
): Promise<void> {
  await client.request<void>({
    method: 'DELETE',
    path: `${base(organizationSlug)}/${encodeURIComponent(entryId)}`,
  });
}

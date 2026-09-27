import type { ApiClient } from './client';

/**
 * Organization access policies (Administration module 18, x174).
 *
 * Wraps the access-policy API: read the organization's access policy (its stored document, or the
 * defaults if none) and update it. The one exported response shape is {@link OrgPolicyView}, paired
 * Exact with the API's `OrgPolicyView` in the contracts gate — the wire projection is the typed policy
 * document and never echoes the tenant id.
 *
 * Distinct from x153 `org-settings.ts` (general string preferences): this is the access-policy surface —
 * session lifetime, invite-domain allowlist, guest access — with typed, bounded values.
 */

/** The organization's access policy — the typed, bounded document. Paired Exact with the API. */
export interface OrgPolicyView {
  readonly policy: {
    readonly session_max_hours: number;
    readonly invite_domain_allowlist: readonly string[];
    readonly guest_access_enabled: boolean;
  };
}

/** The PUT body — a partial policy document; the API validates each field against its allowlist. */
export interface OrgPolicyUpdateInput {
  readonly session_max_hours?: number;
  readonly invite_domain_allowlist?: readonly string[];
  readonly guest_access_enabled?: boolean;
}

function base(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/policies`;
}

/** Read the organization's access policy. */
export async function readOrgPolicy(
  client: ApiClient,
  organizationSlug: string,
): Promise<OrgPolicyView> {
  const { data } = await client.request<OrgPolicyView>({ path: base(organizationSlug) });
  return data;
}

/** Update the organization's access policy. Returns the full policy after the write. */
export async function updateOrgPolicy(
  client: ApiClient,
  organizationSlug: string,
  input: OrgPolicyUpdateInput,
): Promise<OrgPolicyView> {
  const { data } = await client.request<OrgPolicyView>({
    method: 'PUT',
    path: base(organizationSlug),
    body: input,
  });
  return data;
}

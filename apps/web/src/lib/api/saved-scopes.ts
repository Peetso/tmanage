import type { ApiClient } from './client';

/**
 * SRCH saved scopes (x334).
 *
 * A member's own named search **filter scopes** — a scope is a label plus a filter set
 * (`{ objectTypes[], projectId?, from?, to? }`) that pre-filters a search before it runs. Served under
 * `.../search/scopes` behind the `search.use` capability. Every row is the caller's own — the API
 * scopes each read, the create, the replace and the delete by tenant and owner — so the client renders
 * what it is given without a second check. Distinct from saved searches (a saved query) and shares
 * (team sharing): this is a reusable filter scope, applied by handing its filters to the search read.
 */

/** A scope's filter set. Nested in {@link SearchScope}; not exported (the contracts gate enumerates exported shapes). */
interface SearchScopeFilters {
  readonly objectTypes: readonly string[];
  readonly projectId?: string;
  readonly from?: string;
  readonly to?: string;
}

/** A saved scope as the view reads it — paired Exact with the API's `SearchScopeView`. */
export interface SearchScope {
  readonly id: string;
  readonly name: string;
  readonly filters: SearchScopeFilters;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** The create/replace body — request-side, so the contracts gate drops the `Input` suffix. */
export interface SearchScopeInput {
  readonly name: string;
  readonly filters: SearchScopeFilters;
}

function base(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/search/scopes`;
}

export async function listSearchScopes(
  client: ApiClient,
  organizationSlug: string,
): Promise<readonly SearchScope[]> {
  const { data } = await client.request<{ scopes: readonly SearchScope[] }>({
    path: base(organizationSlug),
  });
  return data.scopes;
}

export async function createSearchScope(
  client: ApiClient,
  organizationSlug: string,
  input: SearchScopeInput,
): Promise<SearchScope> {
  const { data } = await client.request<SearchScope>({
    method: 'POST',
    path: base(organizationSlug),
    body: input,
  });
  return data;
}

export async function replaceSearchScope(
  client: ApiClient,
  organizationSlug: string,
  scopeId: string,
  input: SearchScopeInput,
): Promise<SearchScope> {
  const { data } = await client.request<SearchScope>({
    method: 'PUT',
    path: `${base(organizationSlug)}/${encodeURIComponent(scopeId)}`,
    body: input,
  });
  return data;
}

export async function deleteSearchScope(
  client: ApiClient,
  organizationSlug: string,
  scopeId: string,
): Promise<void> {
  await client.request<void>({
    method: 'DELETE',
    path: `${base(organizationSlug)}/${encodeURIComponent(scopeId)}`,
  });
}

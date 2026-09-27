import type { ApiClient } from './client';

/**
 * SRCH saved-search sharing (x272).
 *
 * The sharing half of the saved searches (x214): an owner shares one of their own saved searches
 * with the studio so teammates can run it, and unshares it again, served under
 * `.../search/saved/:id/share` and `.../search/shared` behind the `search.use` capability. The API
 * resolves the saved search before it authorizes (unknown id → 404) and refuses a non-owner (403),
 * so the client renders what it is given without a second check.
 */

/** One remembered filter. Nested in {@link SharedSavedSearch}; not exported (the contracts gate enumerates exported shapes). */
interface SavedSearchFilter {
  readonly field: string;
  readonly value: string;
}

/** A saved search shared with the studio — paired Exact with the API's `SharedSavedSearchView`. */
export interface SharedSavedSearch {
  readonly id: string;
  readonly name: string;
  readonly query: string;
  readonly filters: readonly SavedSearchFilter[];
  readonly ownerUserId: string;
  readonly sharedAt: string;
}

function base(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/search`;
}

export async function listSharedSavedSearches(
  client: ApiClient,
  organizationSlug: string,
): Promise<readonly SharedSavedSearch[]> {
  const { data } = await client.request<{ shared: readonly SharedSavedSearch[] }>({
    path: `${base(organizationSlug)}/shared`,
  });
  return data.shared;
}

export async function shareSavedSearch(
  client: ApiClient,
  organizationSlug: string,
  savedSearchId: string,
): Promise<readonly SharedSavedSearch[]> {
  const { data } = await client.request<{ shared: readonly SharedSavedSearch[] }>({
    method: 'PUT',
    path: `${base(organizationSlug)}/saved/${encodeURIComponent(savedSearchId)}/share`,
  });
  return data.shared;
}

export async function unshareSavedSearch(
  client: ApiClient,
  organizationSlug: string,
  savedSearchId: string,
): Promise<void> {
  await client.request<void>({
    method: 'DELETE',
    path: `${base(organizationSlug)}/saved/${encodeURIComponent(savedSearchId)}/share`,
  });
}

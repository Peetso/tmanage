import type { ApiClient } from './client';

/**
 * SRCH saved/recent searches (x214).
 *
 * A member's own named saved searches (create/list/delete) and their recent queries (read), served
 * under `.../search/saved` and `.../search/recent` behind the `search.use` capability. Every row is
 * the caller's own — the API scopes each read, the delete and the recent prune by tenant and owner —
 * so the client renders what it is given without a second check.
 */

/** One remembered filter. Nested in {@link SavedSearch}; not exported (the contracts gate enumerates exported shapes). */
interface SavedSearchFilter {
  readonly field: string;
  readonly value: string;
}

/** A saved search as the screen reads it — paired Exact with the API's `SavedSearchView`. */
export interface SavedSearch {
  readonly id: string;
  readonly name: string;
  readonly query: string;
  readonly filters: readonly SavedSearchFilter[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** One recent query — paired Exact with the API's `RecentSearchEntry`. */
export interface RecentSearch {
  readonly query: string;
  readonly searchedAt: string;
}

/** The create body — request-side, so the contracts gate drops the `Input` suffix. */
export interface SaveSearchInput {
  readonly name: string;
  readonly query: string;
  readonly filters?: readonly SavedSearchFilter[];
}

function base(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/search`;
}

export async function listSavedSearches(
  client: ApiClient,
  organizationSlug: string,
): Promise<readonly SavedSearch[]> {
  const { data } = await client.request<{ savedSearches: readonly SavedSearch[] }>({
    path: `${base(organizationSlug)}/saved`,
  });
  return data.savedSearches;
}

export async function createSavedSearch(
  client: ApiClient,
  organizationSlug: string,
  input: SaveSearchInput,
): Promise<SavedSearch> {
  const { data } = await client.request<SavedSearch>({
    method: 'POST',
    path: `${base(organizationSlug)}/saved`,
    body: input,
  });
  return data;
}

export async function deleteSavedSearch(
  client: ApiClient,
  organizationSlug: string,
  savedSearchId: string,
): Promise<readonly SavedSearch[]> {
  const { data } = await client.request<{ savedSearches: readonly SavedSearch[] }>({
    method: 'DELETE',
    path: `${base(organizationSlug)}/saved/${encodeURIComponent(savedSearchId)}`,
  });
  return data.savedSearches;
}

export async function listRecentSearches(
  client: ApiClient,
  organizationSlug: string,
): Promise<readonly RecentSearch[]> {
  const { data } = await client.request<{ recent: readonly RecentSearch[] }>({
    path: `${base(organizationSlug)}/recent`,
  });
  return data.recent;
}

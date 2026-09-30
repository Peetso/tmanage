import type { ApiClient } from './client';

/**
 * Search recent history (x288).
 *
 * A member's own recently-run queries — record one, list the most-recent, clear them all — served
 * under `.../search/history` behind the `search.use` capability. Every row is the caller's own: the
 * API scopes each read, the clear and the retention prune by tenant and membership, so the client
 * renders what it is given without a second check.
 */

/** One recent query — paired Exact with the API's `SearchHistoryEntryView`. */
export interface SearchHistoryEntry {
  readonly query: string;
  readonly recordedAt: string;
}

function historyPath(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/search/history`;
}

/** Record one query the member ran; returns their recent list (newest first, deduped, bounded). */
export async function recordSearch(
  client: ApiClient,
  organizationSlug: string,
  query: string,
): Promise<readonly SearchHistoryEntry[]> {
  const { data } = await client.request<{ history: readonly SearchHistoryEntry[] }>({
    method: 'POST',
    path: historyPath(organizationSlug),
    body: { query },
  });
  return data.history;
}

/** The caller's recent queries, most-recent first and bounded. */
export async function listSearchHistory(
  client: ApiClient,
  organizationSlug: string,
): Promise<readonly SearchHistoryEntry[]> {
  const { data } = await client.request<{ history: readonly SearchHistoryEntry[] }>({
    path: historyPath(organizationSlug),
  });
  return data.history;
}

/** Clear the caller's history; returns the now-empty list. */
export async function clearSearchHistory(
  client: ApiClient,
  organizationSlug: string,
): Promise<readonly SearchHistoryEntry[]> {
  const { data } = await client.request<{ history: readonly SearchHistoryEntry[] }>({
    method: 'DELETE',
    path: historyPath(organizationSlug),
  });
  return data.history;
}

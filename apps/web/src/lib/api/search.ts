import type { ApiClient } from './client';

/**
 * SRCH-01 (x111) — global search.
 *
 * A single read the API serves at `GET .../search?q=&projectId?=&limit?=`, behind the `search.use`
 * capability. No write, no request body: the inputs are query parameters. Every hit the API
 * returns is one the caller may read — the server relation-gates each row with `work.read`, so the
 * client renders what it is given without a second permission check.
 */

/** The kinds a hit can be. Kept in lockstep with the API's `SearchResultKind`. */
export type SearchResultKind = 'work_item' | 'document' | 'meeting';

/**
 * One unified search hit — paired Exact with the API's `SearchResultView` in the contracts gate.
 * `snippet` is null until body search lands (NEXT-SCOPES-9); the field is here now so the excerpt
 * can be rendered then without a shape change.
 */
export interface SearchResult {
  readonly kind: SearchResultKind;
  readonly id: string;
  readonly title: string;
  readonly projectId: string;
  readonly snippet: string | null;
}

export interface SearchQuery {
  readonly q: string;
  readonly projectId?: string;
  readonly limit?: number;
}

export async function search(
  client: ApiClient,
  organizationSlug: string,
  query: SearchQuery,
): Promise<readonly SearchResult[]> {
  const parameters = new URLSearchParams();
  parameters.set('q', query.q);
  if (query.projectId) parameters.set('projectId', query.projectId);
  if (query.limit !== undefined) parameters.set('limit', String(query.limit));

  const { data } = await client.request<{ results: readonly SearchResult[] }>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/search?${parameters.toString()}`,
  });
  return data.results;
}

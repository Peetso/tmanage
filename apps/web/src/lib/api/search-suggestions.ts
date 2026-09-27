import type { ApiClient } from './client';

/**
 * SRCH typeahead / suggestions (x289) — the read behind the search box's autocomplete.
 *
 * A single read the API serves at `GET .../search/suggest?q=<prefix>&limit?=`, behind the `search.use`
 * capability (the same coarse ceiling global search and the command palette read under). It returns
 * ranked suggestion **strings** — indexed entity titles predicted from the prefix — each one already
 * relation-gated by the server (`work.read`), so the client renders what it is given without a second
 * permission check. No write, no body: the inputs are query parameters. A blank prefix returns an
 * empty list.
 */

/** The default and the ceiling the API enforces on `limit`; the client mirrors the cap. */
export const SUGGEST_DEFAULT_LIMIT = 8;
export const SUGGEST_MAX_LIMIT = 20;

export interface SuggestQuery {
  readonly q: string;
  readonly limit?: number;
}

/**
 * Fetch typeahead suggestions for a prefix. Paired Exact with the API's `{ suggestions: string[] }`
 * response in the contracts gate: a suggestion is a bare title string, deliberately distinct from a
 * `SearchResult` (a row) and a `Command` (a fixed navigation/action).
 */
export async function fetchSuggestions(
  client: ApiClient,
  organizationSlug: string,
  query: SuggestQuery,
): Promise<readonly string[]> {
  const prefix = query.q.trim();
  if (prefix === '') return [];

  const parameters = new URLSearchParams();
  parameters.set('q', prefix);
  if (query.limit !== undefined) parameters.set('limit', String(query.limit));

  const { data } = await client.request<{ suggestions: readonly string[] }>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/search/suggest?${parameters.toString()}`,
  });
  return data.suggestions;
}

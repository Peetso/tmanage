'use client';

import { useQuery } from '@tanstack/react-query';
import { browserApiClient } from '../../lib/api/browser-client';
import { fetchSuggestions } from '../../lib/api/search-suggestions';
import type { ApiClient } from '../../lib/api/client';

export interface SearchSuggestListProps {
  organizationSlug: string;
  /** The current search-box prefix. A blank one renders nothing (no fetch, no list). */
  query: string;
  /** Called when a suggestion is chosen — the parent typically fills the box and runs the search. */
  onSelect: (suggestion: string) => void;
  /** The id of the input this list describes, so the box can point `aria-controls` at it. */
  listId?: string;
  /** Test seam: an explicit API client. */
  client?: ApiClient;
}

/**
 * **SRCH typeahead / suggestions (x289).**
 *
 * `22-SCREEN` SR search typeahead: the inline suggestion list that drops under the search box as the
 * caller types. Each entry is a bare indexed title predicted from the prefix — distinct from the
 * recent-history list (x288, queries the caller ran) and the command palette (x181, fixed
 * navigations/actions).
 *
 * ## What it draws, and what it cannot
 *
 * - **Every suggestion is one the caller may read.** The API relation-gates each candidate with
 *   `work.read` before returning it, so the list renders what it is given without a second check — a
 *   suggestion never surfaces a title the item's own screen would deny.
 * - **Order is the server's** — most-recent first — rendered as one flat sequence with no client
 *   re-sort. Titles are de-duplicated and the set is bounded (default 8, max 20) by the API.
 * - **A blank prefix is not a search:** nothing is fetched or drawn until the caller has typed. A
 *   fetch error is swallowed to nothing — typeahead is a convenience and must never shout over the
 *   box the caller is still typing in.
 */
export function SearchSuggestList({
  organizationSlug,
  query,
  onSelect,
  listId,
  client,
}: SearchSuggestListProps) {
  const api = client ?? browserApiClient();
  const prefix = query.trim();

  const suggestions = useQuery({
    queryKey: ['search-suggest', organizationSlug, prefix],
    queryFn: () => fetchSuggestions(api, organizationSlug, { q: prefix }),
    enabled: prefix !== '',
  });

  const items = suggestions.data ?? [];
  if (prefix === '' || items.length === 0) return null;

  return (
    <ul
      id={listId}
      className="tm-stack tm-list"
      role="listbox"
      aria-label={`Suggestions for “${prefix}”`}
    >
      {items.map((suggestion) => (
        <li key={suggestion} role="presentation">
          <button
            type="button"
            role="option"
            aria-selected={false}
            className="tm-button tm-button--ghost"
            onClick={() => onSelect(suggestion)}
          >
            {suggestion}
          </button>
        </li>
      ))}
    </ul>
  );
}

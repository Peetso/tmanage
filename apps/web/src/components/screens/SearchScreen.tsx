'use client';

import { useState } from 'react';
import type { FormEvent } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { search } from '../../lib/api/search';
import type { SearchResultKind } from '../../lib/api/search';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface SearchScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** Preselect a query — how a link (`?q=`) opens straight onto its results. */
  initialQuery?: string;
  client?: ApiClient;
}

/** The singular label each hit carries so its kind stays legible in one flat, ranked list. */
const KIND_LABEL: Readonly<Record<SearchResultKind, string>> = {
  work_item: 'Work item',
  document: 'Document',
  meeting: 'Meeting',
};

/**
 * **SRCH-01 Global search (x111), ranked by SRCH ranking (x148).**
 *
 * `41-WHOLE-APP-SCREEN-AND-STATE-MATRIX` §Search: a global search bar over a unified result set.
 * This is the smallest useful form of it — a query box and the tenant-scoped hits the API returns.
 *
 * ## What it draws, and what it cannot
 *
 * - **Every hit is one the caller may read.** The API relation-gates each row with `work.read`
 *   before it is returned, so the screen renders what it is given without a second permission
 *   check — a search never surfaces an item the item's own screen would deny.
 * - **Order is the server's ranking** — relevance, then recency — so the list is rendered as one
 *   flat sequence in the exact order the API returns, with no client-side re-sort or re-grouping
 *   to drift from the score. Each row carries its kind as a label so the mix stays legible.
 * - **Only work items link to a detail page**, because only work items have one today. A document
 *   or meeting hit names its title and project; per-item deep links are a later slice, the same
 *   honesty the timeline applies to columns with no data behind them.
 * - **Body/snippet matching is not here yet** — `snippet` is null until snippet extraction lands
 *   (NS-13); ranking is over the full-text index the API owns (0054).
 *
 * A query must be entered and submitted before anything is fetched: an empty search is not a
 * search, and the API rejects one.
 */
export function SearchScreen({
  organizationSlug,
  organizationName,
  initialQuery,
  client,
}: SearchScreenProps) {
  const api = client ?? browserApiClient();
  const [draft, setDraft] = useState<string>(initialQuery ?? '');
  const [query, setQuery] = useState<string>(initialQuery?.trim() ?? '');

  const results = useQuery({
    queryKey: ['search', organizationSlug, query],
    queryFn: () => search(api, organizationSlug, { q: query }),
    enabled: query !== '',
  });

  const hits = results.data ?? [];
  const total = hits.length;

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setQuery(draft.trim());
  }

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      title="Search"
      description="Find work items, documents and meetings across this organization."
    >
      <section className="tm-panel tm-panel--quiet tm-stack" aria-labelledby="tm-search-form">
        <h2 id="tm-search-form" className="tm-eyebrow">
          Search
        </h2>
        <form className="tm-stack" onSubmit={onSubmit} role="search">
          <div className="tm-field">
            <label className="tm-field__label" htmlFor="tm-search-q">
              What are you looking for?
            </label>
            <input
              id="tm-search-q"
              className="tm-field__control"
              type="search"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Title of a work item, document or meeting"
            />
            <span className="tm-field__hint">
              Matches titles across work items, documents and meetings you can see.
            </span>
          </div>
          <div>
            <button type="submit" className="tm-button" disabled={draft.trim() === ''}>
              Search
            </button>
          </div>
        </form>
      </section>

      {query === '' ? (
        <InlineAlert tone="neutral" title="Search this organization">
          Enter a word or two above to find work items, documents and meetings you can see.
        </InlineAlert>
      ) : null}

      {results.isError ? (
        <InlineAlert tone="danger" title="Could not run the search" live>
          {describeError(results.error)}
        </InlineAlert>
      ) : null}

      {query !== '' && results.isPending ? (
        <LoadingRegion label="Running the search.">
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {query !== '' && !results.isPending && !results.isError && total === 0 ? (
        <InlineAlert tone="neutral" title="No matches">
          Nothing you can see matches “{query}”. Try a different word.
        </InlineAlert>
      ) : null}

      {total > 0 ? (
        <section className="tm-panel tm-stack" aria-labelledby="tm-search-results">
          <h2 id="tm-search-results" className="tm-eyebrow">
            Results ({total})
          </h2>
          <ul className="tm-stack tm-list" aria-label="Search results, most relevant first">
            {hits.map((hit) => (
              <li key={`${hit.kind}:${hit.id}`} className="tm-prose">
                <span className="tm-eyebrow tm-muted">{KIND_LABEL[hit.kind]}</span>{' '}
                {hit.kind === 'work_item' ? (
                  <Link href={`/${organizationSlug}/work/${hit.id}`}>{hit.title}</Link>
                ) : (
                  <span>{hit.title}</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </AppShell>
  );
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}

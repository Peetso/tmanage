'use client';

import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { search } from '../../lib/api/search';
import type { SearchResult, SearchResultKind } from '../../lib/api/search';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface SearchScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** Preselect a query — how a link (`?q=`) opens straight onto its results. */
  initialQuery?: string;
  client?: ApiClient;
}

/** The kinds, in the order the API returns them, each with its plural heading. */
const GROUPS: readonly { readonly kind: SearchResultKind; readonly heading: string }[] = [
  { kind: 'work_item', heading: 'Work items' },
  { kind: 'document', heading: 'Documents' },
  { kind: 'meeting', heading: 'Meetings' },
];

/**
 * **SRCH-01 Global search (x111).**
 *
 * `41-WHOLE-APP-SCREEN-AND-STATE-MATRIX` §Search: a global search bar over a unified result set.
 * This is the smallest useful form of it — a query box and the tenant-scoped hits the API returns,
 * grouped by kind (work items, documents, meetings).
 *
 * ## What it draws, and what it cannot
 *
 * - **Every hit is one the caller may read.** The API relation-gates each row with `work.read`
 *   before it is returned, so the screen renders what it is given without a second permission
 *   check — a search never surfaces an item the item's own screen would deny.
 * - **Order is the server's** — kind, then title — so the sequence down each group is the
 *   sequence the API means; there is no client-side re-sort to drift from it.
 * - **Only work items link to a detail page**, because only work items have one today. A document
 *   or meeting hit names its title and project; per-item deep links are a later slice, the same
 *   honesty the timeline applies to columns with no data behind them.
 * - **Ranking, relevance and body/snippet matching are not here** — the match is over titles, and
 *   `snippet` is null until body search lands (NEXT-SCOPES-9).
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

  const grouped = useMemo(() => {
    const byKind = new Map<SearchResultKind, SearchResult[]>();
    for (const group of GROUPS) byKind.set(group.kind, []);
    for (const hit of results.data ?? []) byKind.get(hit.kind)?.push(hit);
    return byKind;
  }, [results.data]);

  const total = results.data?.length ?? 0;

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

      {total > 0
        ? GROUPS.map((group) => {
            const hits = grouped.get(group.kind) ?? [];
            if (hits.length === 0) return null;
            const headingId = `tm-search-group-${group.kind}`;
            return (
              <section key={group.kind} className="tm-panel tm-stack" aria-labelledby={headingId}>
                <h2 id={headingId} className="tm-eyebrow">
                  {group.heading} ({hits.length})
                </h2>
                <ul className="tm-stack tm-list" aria-label={group.heading}>
                  {hits.map((hit) => (
                    <li key={`${hit.kind}:${hit.id}`} className="tm-prose">
                      {hit.kind === 'work_item' ? (
                        <Link href={`/${organizationSlug}/work/${hit.id}`}>{hit.title}</Link>
                      ) : (
                        <span>{hit.title}</span>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            );
          })
        : null}
    </AppShell>
  );
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}

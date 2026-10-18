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
import { getResolvedFeatureFlags } from '../../lib/api/admin-feature-flags';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import '../../styles/screens/search-ai.css';

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

/** The TYPE facet capsules (SR-02), in the order the design lists them. */
const KIND_ORDER: readonly SearchResultKind[] = ['work_item', 'document', 'meeting'];
const KIND_FACET: Readonly<Record<SearchResultKind, string>> = {
  work_item: 'Work',
  document: 'Docs',
  meeting: 'Meetings',
};

/**
 * **SRCH-01 Global search (x111), ranked by SRCH ranking (x148)** — drawn as SR-02 Universal
 * search: the lime-ringed search capsule across the top, the TYPE facet column on the start side
 * and the ranked result cards beside it.
 *
 * ## What it draws, and what it cannot
 *
 * - **Every hit is one the caller may read.** The API relation-gates each row with `work.read`
 *   before it is returned, so the screen renders what it is given without a second permission
 *   check — a search never surfaces an item the item's own screen would deny. The "Hidden from
 *   you" note states that rule; it does not invent a count the API does not return.
 * - **Order is the server's ranking** — relevance, then recency — so the list is rendered in the
 *   exact order the API returns. The TYPE facet only hides kinds; it never re-sorts.
 * - **Only work items link to a detail page**, because only work items have one today.
 * - **Body/snippet matching is not here yet** — `snippet` is null until snippet extraction lands;
 *   the card draws the excerpt line only when there is one.
 * - The design's AUDIENCE and TIME facets are not drawn: the search endpoint takes neither filter.
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
  const [kind, setKind] = useState<'all' | SearchResultKind>('all');

  const results = useQuery({
    queryKey: ['search', organizationSlug, query],
    queryFn: () => search(api, organizationSlug, { q: query }),
    enabled: query !== '',
  });

  // The copilot is an optional module: its "Ask" affordance appears only when the `copilot` feature
  // flag is resolved on for this org. While the flag read is pending or fails, the affordance stays
  // hidden — no dead button — and the copilot route's own 404 (flag off) is the belt to this braces.
  const flags = useQuery({
    queryKey: ['resolved-feature-flags', organizationSlug],
    queryFn: () => getResolvedFeatureFlags(api, organizationSlug),
  });
  const copilotEnabled = flags.data?.flags.copilot === true;

  const hits = results.data ?? [];
  const total = hits.length;
  const askQuery = (query !== '' ? query : draft).trim();
  const shown = kind === 'all' ? hits : hits.filter((hit) => hit.kind === kind);
  const org = encodeURIComponent(organizationSlug);
  const settled = query !== '' && !results.isPending && !results.isError;

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setQuery(draft.trim());
    setKind('all');
  }

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      title="Search"
    >
      <div className="tm-sa-search tm-sa-headerless">
        <form className="tm-sa-searchbar" onSubmit={onSubmit} role="search">
          <span className="tm-sa-searchbar__glyph" aria-hidden="true">
            ⌕
          </span>
          <label className="tm-visually-hidden" htmlFor="tm-search-q">
            What are you looking for?
          </label>
          <input
            id="tm-search-q"
            className="tm-sa-searchbar__input"
            type="search"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Search work, documents and meetings you can see"
          />
          <div className="tm-sa-searchbar__actions">
            {settled ? (
              <span className="tm-sa-searchbar__count" aria-live="polite">
                {total} {total === 1 ? 'result' : 'results'}
              </span>
            ) : null}
            {copilotEnabled ? (
              <Link
                href={
                  askQuery === ''
                    ? `/${org}/copilot`
                    : `/${org}/copilot?q=${encodeURIComponent(askQuery)}`
                }
                className="tm-sa-capsule"
              >
                Ask copilot
              </Link>
            ) : null}
            {query !== '' ? (
              <Link
                href={`/${org}/search/saved?q=${encodeURIComponent(query)}`}
                className="tm-sa-capsule"
              >
                Save this search
              </Link>
            ) : null}
            <button
              type="submit"
              className="tm-sa-capsule tm-sa-capsule--ink"
              disabled={draft.trim() === ''}
            >
              Search
            </button>
          </div>
        </form>

        <div className="tm-sa-search__body">
          <div className="tm-sa-facets">
            <div className="tm-sa-facet" role="group" aria-labelledby="tm-search-type">
              <p id="tm-search-type" className="tm-sa-eyebrow">
                Type
              </p>
              <div className="tm-chip-row">
                <button
                  type="button"
                  className="tm-chip"
                  aria-pressed={kind === 'all'}
                  onClick={() => setKind('all')}
                >
                  All {total}
                </button>
                {KIND_ORDER.map((value) => {
                  const count = hits.filter((hit) => hit.kind === value).length;
                  return (
                    <button
                      key={value}
                      type="button"
                      className="tm-chip"
                      aria-pressed={kind === value}
                      onClick={() => setKind(value)}
                      disabled={count === 0}
                    >
                      {KIND_FACET[value]} {count}
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="tm-sa-note">
              <p className="tm-sa-eyebrow">Hidden from you</p>
              <p className="tm-sa-note__body">
                Results are filtered by your access before they are ranked. Matches in projects you
                are not on are never shown, not even their titles.
              </p>
            </div>
          </div>

          <section className="tm-sa-results" aria-labelledby="tm-search-results">
            <h2 id="tm-search-results" className="tm-sa-eyebrow">
              {total > 0 ? `Results (${total}) · sorted by relevance` : 'Results'}
            </h2>

            {query === '' ? (
              <div className="tm-sa-empty">
                <p className="tm-sa-empty__title">Search this organization</p>
                <p className="tm-sa-empty__body">
                  Enter a word or two above to find work items, documents and meetings you can see.
                </p>
              </div>
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

            {settled && total === 0 ? (
              <div className="tm-sa-empty" role="status">
                <p className="tm-sa-empty__title">No matches</p>
                <p className="tm-sa-empty__body">
                  Nothing you can see matches “{query}”. Try a different word.
                </p>
              </div>
            ) : null}

            {total > 0 ? (
              <ul className="tm-sa-results__list" aria-label="Search results, most relevant first">
                {shown.map((hit) => (
                  <li key={`${hit.kind}:${hit.id}`} className="tm-sa-hit">
                    <div className="tm-sa-hit__head">
                      <span className="tm-sa-badge">{KIND_LABEL[hit.kind]}</span>
                      {hit.kind === 'work_item' ? (
                        <Link
                          href={`/${organizationSlug}/work/${hit.id}`}
                          className="tm-sa-hit__title"
                        >
                          {hit.title}
                        </Link>
                      ) : (
                        <span className="tm-sa-hit__title">{hit.title}</span>
                      )}
                      <span className="tm-sa-hit__ref" aria-hidden="true">
                        {shortRef(hit.id)}
                      </span>
                    </div>
                    {hit.snippet ? <p className="tm-sa-hit__body">{hit.snippet}</p> : null}
                    <p className="tm-sa-hit__meta">Project {shortRef(hit.projectId)}</p>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
        </div>
      </div>
    </AppShell>
  );
}

/** The design's short mono reference ("8F2C·D41A"): the first eight hex digits of an id. */
export function shortRef(id: string): string {
  const hex = id.replace(/[^0-9a-f]/gi, '').toUpperCase();
  return hex.length >= 8 ? `${hex.slice(0, 4)}·${hex.slice(4, 8)}` : id.toUpperCase();
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}

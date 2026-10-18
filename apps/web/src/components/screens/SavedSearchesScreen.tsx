'use client';

import { useState } from 'react';
import type { FormEvent } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  createSavedSearch,
  deleteSavedSearch,
  listRecentSearches,
  listSavedSearches,
} from '../../lib/api/saved-searches';
import type { SavedSearch } from '../../lib/api/saved-searches';
import { search } from '../../lib/api/search';
import type { SearchResultKind } from '../../lib/api/search';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import { shortRef } from './SearchScreen';
import '../../styles/screens/search-ai.css';

export interface SavedSearchesScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** Prefill the new-search form — how SR-02's "Save this search" hands over its query. */
  initialQuery?: string;
  client?: ApiClient;
}

const KIND_LABEL: Readonly<Record<SearchResultKind, string>> = {
  work_item: 'Work item',
  document: 'Document',
  meeting: 'Meeting',
};

const DATE = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });

/**
 * **SRCH saved & recent searches (x214)** — drawn as SR-04 Saved search: the saved list in a
 * paper column on the start side, and the selected search as a standing question on the right —
 * its name as the headline, its query as capsules and its current results in a table.
 *
 * Everything here is the caller's own: the API scopes each read, the delete and the recent prune by
 * tenant and owner, so the screen renders what it is given. The results table re-runs the saved
 * query through the same permission-filtered search endpoint SR-02 uses. The design's digest
 * schedule and sharing are not drawn: no endpoint stores either yet.
 */
export function SavedSearchesScreen({
  organizationSlug,
  organizationName,
  initialQuery,
  client,
}: SavedSearchesScreenProps) {
  const api = client ?? browserApiClient();
  const queries = useQueryClient();

  const [name, setName] = useState('');
  const [query, setQuery] = useState(initialQuery ?? '');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [composing, setComposing] = useState(initialQuery !== undefined && initialQuery !== '');

  const savedKey = ['saved-searches', organizationSlug];
  const recentKey = ['recent-searches', organizationSlug];

  const saved = useQuery({
    queryKey: savedKey,
    queryFn: () => listSavedSearches(api, organizationSlug),
  });
  const recent = useQuery({
    queryKey: recentKey,
    queryFn: () => listRecentSearches(api, organizationSlug),
  });

  const savedList = saved.data ?? [];
  const recentList = recent.data ?? [];
  const selected: SavedSearch | undefined =
    savedList.find((item) => item.id === selectedId) ?? savedList[0];
  const showForm = composing || (!saved.isPending && !saved.isError && savedList.length === 0);

  const results = useQuery({
    queryKey: ['search', organizationSlug, selected?.query ?? ''],
    queryFn: () => search(api, organizationSlug, { q: selected!.query }),
    enabled: selected !== undefined && selected.query.trim() !== '',
  });

  const create = useMutation({
    mutationFn: () =>
      createSavedSearch(api, organizationSlug, { name: name.trim(), query: query.trim() }),
    onSuccess: (created) => {
      setName('');
      setQuery('');
      setComposing(false);
      if (created?.id) setSelectedId(created.id);
      void queries.invalidateQueries({ queryKey: savedKey });
    },
  });

  const remove = useMutation({
    mutationFn: (savedSearchId: string) => deleteSavedSearch(api, organizationSlug, savedSearchId),
    onSuccess: () => {
      setSelectedId(null);
      void queries.invalidateQueries({ queryKey: savedKey });
    },
  });

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (name.trim() === '' || query.trim() === '') return;
    create.mutate();
  }

  const searchHref = (q: string) => `/${organizationSlug}/search?q=${encodeURIComponent(q)}`;
  const hits = results.data ?? [];

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      title="Saved searches"
    >
      <div className="tm-sa-saved tm-sa-headerless">
        <div className="tm-sa-saved__rail">
          <section className="tm-stack" aria-labelledby="tm-saved-list">
            <h2 id="tm-saved-list" className="tm-sa-eyebrow">
              Saved searches{savedList.length > 0 ? ` · ${savedList.length}` : ''}
            </h2>
            {saved.isError ? (
              <InlineAlert tone="danger" title="Could not load your saved searches" live>
                {describeError(saved.error)}
              </InlineAlert>
            ) : null}
            {saved.isPending ? (
              <LoadingRegion label="Loading your saved searches.">
                <Skeleton height="var(--row)" />
                <Skeleton height="var(--row)" />
              </LoadingRegion>
            ) : null}
            {!saved.isPending && !saved.isError && savedList.length === 0 ? (
              <div className="tm-sa-empty">
                <p className="tm-sa-empty__title">No saved searches yet</p>
                <p className="tm-sa-empty__body">Save a search to keep it here.</p>
              </div>
            ) : null}
            {savedList.length > 0 ? (
              <ul className="tm-sa-saved__list" aria-label="Your saved searches">
                {savedList.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      className="tm-sa-saved-item"
                      aria-current={item.id === selected?.id ? 'true' : undefined}
                      onClick={() => {
                        setSelectedId(item.id);
                        setComposing(false);
                      }}
                    >
                      <span className="tm-sa-saved-item__name">{item.name}</span>
                      <span className="tm-sa-saved-item__meta">
                        “{item.query}”
                        {item.filters.length > 0
                          ? ` · ${item.filters.length} ${item.filters.length === 1 ? 'filter' : 'filters'}`
                          : ''}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>

          <section className="tm-stack" aria-labelledby="tm-recent-list">
            <h2 id="tm-recent-list" className="tm-sa-eyebrow">
              Recent searches
            </h2>
            {recent.isPending ? (
              <LoadingRegion label="Loading your recent searches.">
                <Skeleton height="var(--row)" />
              </LoadingRegion>
            ) : null}
            {!recent.isPending && !recent.isError && recentList.length === 0 ? (
              <p className="tm-sa-saved-item__meta">
                Searches you run will show up here so you can pick them up again.
              </p>
            ) : null}
            {recentList.length > 0 ? (
              <ul
                className="tm-sa-saved__list"
                aria-label="Your recent searches, most recent first"
              >
                {recentList.map((item) => (
                  <li key={`${item.searchedAt}:${item.query}`}>
                    <Link href={searchHref(item.query)} className="tm-sa-saved-item">
                      <span className="tm-sa-saved-item__name">{item.query}</span>
                      <span className="tm-sa-saved-item__meta">
                        {DATE.format(new Date(item.searchedAt))}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>

          <div className="tm-sa-saved__foot">
            <button
              type="button"
              className="tm-sa-capsule"
              aria-expanded={showForm}
              aria-controls="tm-saved-search-form"
              onClick={() => setComposing(true)}
            >
              New saved search
            </button>
          </div>
        </div>

        <div className="tm-sa-saved__main">
          {showForm ? (
            <div className="tm-sa-saved__titles">
              <p className="tm-sa-saved__eyebrow">Saved search · a standing question</p>
              <p className="tm-sa-saved__title" aria-hidden="true">
                New saved search
              </p>
            </div>
          ) : null}
          {showForm ? (
            <section
              id="tm-saved-search-form"
              className="tm-sa-form"
              aria-labelledby="tm-saved-search-form-title"
            >
              <h2 id="tm-saved-search-form-title" className="tm-sa-eyebrow">
                Save a search
              </h2>
              <form className="tm-stack" onSubmit={onSubmit}>
                <div className="tm-sa-form__fields">
                  <div className="tm-field">
                    <label className="tm-field__label" htmlFor="tm-saved-name">
                      Name
                    </label>
                    <input
                      id="tm-saved-name"
                      className="tm-field__control"
                      type="text"
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      placeholder="e.g. My open work"
                    />
                  </div>
                  <div className="tm-field">
                    <label className="tm-field__label" htmlFor="tm-saved-query">
                      Query
                    </label>
                    <input
                      id="tm-saved-query"
                      className="tm-field__control"
                      type="search"
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      placeholder="The words to search for"
                    />
                  </div>
                </div>
                <div className="tm-sa-form__actions">
                  <Button
                    type="submit"
                    tone="ink"
                    disabled={name.trim() === '' || query.trim() === '' || create.isPending}
                  >
                    Save search
                  </Button>
                  {savedList.length > 0 ? (
                    <Button type="button" tone="outline" onClick={() => setComposing(false)}>
                      Cancel
                    </Button>
                  ) : null}
                </div>
                {create.isError ? (
                  <InlineAlert tone="danger" title="Could not save the search" live>
                    {describeError(create.error)}
                  </InlineAlert>
                ) : null}
              </form>
            </section>
          ) : null}

          {selected && !showForm ? (
            <>
              <div className="tm-sa-saved__head">
                <div className="tm-sa-saved__titles">
                  <p className="tm-sa-saved__eyebrow">
                    Saved search · saved {DATE.format(new Date(selected.createdAt))}
                  </p>
                  <h2 className="tm-sa-saved__title">{selected.name}</h2>
                </div>
                <div className="tm-sa-saved__actions">
                  <button
                    type="button"
                    className="tm-sa-capsule"
                    onClick={() => remove.mutate(selected.id)}
                    disabled={remove.isPending}
                  >
                    Delete
                  </button>
                  <Link
                    href={searchHref(selected.query)}
                    className="tm-sa-capsule tm-sa-capsule--ink"
                  >
                    Open in search
                  </Link>
                </div>
              </div>

              {remove.isError ? (
                <InlineAlert tone="danger" title="Could not delete the search" live>
                  {describeError(remove.error)}
                </InlineAlert>
              ) : null}

              <div className="tm-sa-query">
                <p id="tm-saved-query-label" className="tm-sa-eyebrow">
                  Query
                </p>
                <ul className="tm-sa-query" aria-labelledby="tm-saved-query-label">
                  <li className="tm-sa-query__chip">“{selected.query}”</li>
                  {selected.filters.map((filter) => (
                    <li key={`${filter.field}:${filter.value}`} className="tm-sa-query__chip">
                      {filter.field} = {filter.value}
                    </li>
                  ))}
                </ul>
              </div>

              <section className="tm-sa-table" aria-label="Current results">
                {results.isPending ? (
                  <LoadingRegion label="Running the saved search.">
                    <Skeleton height="var(--row)" />
                    <Skeleton height="var(--row)" />
                  </LoadingRegion>
                ) : null}
                {results.isError ? (
                  <InlineAlert tone="danger" title="Could not run the saved search" live>
                    {describeError(results.error)}
                  </InlineAlert>
                ) : null}
                {!results.isPending && !results.isError && hits.length === 0 ? (
                  <div className="tm-sa-empty">
                    <p className="tm-sa-empty__title">Nothing matches right now</p>
                    <p className="tm-sa-empty__body">
                      Nothing you can see matches “{selected.query}” today. It stays saved and will
                      show matches as they appear.
                    </p>
                  </div>
                ) : null}
                {hits.length > 0 ? (
                  <table className="tm-sa-table__grid">
                    <thead>
                      <tr>
                        <th scope="col">Item</th>
                        <th scope="col">Type</th>
                        <th scope="col">Reference</th>
                      </tr>
                    </thead>
                    <tbody>
                      {hits.map((hit) => (
                        <tr key={`${hit.kind}:${hit.id}`}>
                          <td className="tm-sa-table__item">
                            {hit.kind === 'work_item' ? (
                              <Link href={`/${organizationSlug}/work/${hit.id}`}>{hit.title}</Link>
                            ) : (
                              hit.title
                            )}
                          </td>
                          <td>{KIND_LABEL[hit.kind]}</td>
                          <td className="tm-sa-table__mono">{shortRef(hit.id)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : null}
                <div className="tm-sa-table__foot">
                  <span>
                    {hits.length} {hits.length === 1 ? 'match' : 'matches'} · filtered by your
                    access before ranking
                  </span>
                  <Link href={searchHref(selected.query)} className="tm-sa-link">
                    Refine in search
                  </Link>
                </div>
              </section>
            </>
          ) : null}
        </div>
      </div>
    </AppShell>
  );
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}

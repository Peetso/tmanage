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
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface SavedSearchesScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

/**
 * **SRCH saved & recent searches (x214).**
 *
 * `38-MODULE-MAP` §Search: on top of the SRCH-01 global search (x111) and its ranking (x148), a
 * member keeps named searches and sees the queries they recently ran. This screen is that surface —
 * a form to save a named search, the caller's own saved searches with a delete, and their recent
 * queries as links back into the search screen.
 *
 * Everything here is the caller's own: the API scopes each read, the delete and the recent prune by
 * tenant and owner, so the screen renders what it is given. A saved search re-runs by opening the
 * search screen at `?q=` — this slice persists and lists; applying a saved filter set is the search
 * screen's job.
 */
export function SavedSearchesScreen({
  organizationSlug,
  organizationName,
  client,
}: SavedSearchesScreenProps) {
  const api = client ?? browserApiClient();
  const queries = useQueryClient();

  const [name, setName] = useState('');
  const [query, setQuery] = useState('');

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

  const create = useMutation({
    mutationFn: () =>
      createSavedSearch(api, organizationSlug, { name: name.trim(), query: query.trim() }),
    onSuccess: () => {
      setName('');
      setQuery('');
      void queries.invalidateQueries({ queryKey: savedKey });
    },
  });

  const remove = useMutation({
    mutationFn: (savedSearchId: string) => deleteSavedSearch(api, organizationSlug, savedSearchId),
    onSuccess: () => {
      void queries.invalidateQueries({ queryKey: savedKey });
    },
  });

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (name.trim() === '' || query.trim() === '') return;
    create.mutate();
  }

  const savedList = saved.data ?? [];
  const recentList = recent.data ?? [];

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      title="Saved searches"
      description="Keep searches you run often, and pick up the ones you ran recently."
    >
      <section className="tm-panel tm-panel--quiet tm-stack" aria-labelledby="tm-saved-search-form">
        <h2 id="tm-saved-search-form" className="tm-eyebrow">
          Save a search
        </h2>
        <form className="tm-stack" onSubmit={onSubmit}>
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
          <div>
            <Button
              type="submit"
              disabled={name.trim() === '' || query.trim() === '' || create.isPending}
            >
              Save search
            </Button>
          </div>
          {create.isError ? (
            <InlineAlert tone="danger" title="Could not save the search" live>
              {describeError(create.error)}
            </InlineAlert>
          ) : null}
        </form>
      </section>

      <section className="tm-panel tm-stack" aria-labelledby="tm-saved-list">
        <h2 id="tm-saved-list" className="tm-eyebrow">
          Your saved searches
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
          <InlineAlert tone="neutral" title="No saved searches yet">
            Save a search above to keep it here.
          </InlineAlert>
        ) : null}
        {savedList.length > 0 ? (
          <ul className="tm-stack tm-list" aria-label="Your saved searches">
            {savedList.map((item) => (
              <li key={item.id} className="tm-row">
                <Link href={`/${organizationSlug}/search?q=${encodeURIComponent(item.query)}`}>
                  {item.name}
                </Link>{' '}
                <span className="tm-muted">“{item.query}”</span>{' '}
                <Button
                  type="button"
                  tone="outline"
                  size="accessible"
                  onClick={() => remove.mutate(item.id)}
                  disabled={remove.isPending}
                >
                  Delete
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
        {remove.isError ? (
          <InlineAlert tone="danger" title="Could not delete the search" live>
            {describeError(remove.error)}
          </InlineAlert>
        ) : null}
      </section>

      <section className="tm-panel tm-stack" aria-labelledby="tm-recent-list">
        <h2 id="tm-recent-list" className="tm-eyebrow">
          Recent searches
        </h2>
        {recent.isPending ? (
          <LoadingRegion label="Loading your recent searches.">
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}
        {!recent.isPending && !recent.isError && recentList.length === 0 ? (
          <InlineAlert tone="neutral" title="No recent searches">
            Searches you run will show up here so you can pick them up again.
          </InlineAlert>
        ) : null}
        {recentList.length > 0 ? (
          <ul className="tm-stack tm-list" aria-label="Your recent searches, most recent first">
            {recentList.map((item) => (
              <li key={`${item.searchedAt}:${item.query}`} className="tm-prose">
                <Link href={`/${organizationSlug}/search?q=${encodeURIComponent(item.query)}`}>
                  {item.query}
                </Link>
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </AppShell>
  );
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}

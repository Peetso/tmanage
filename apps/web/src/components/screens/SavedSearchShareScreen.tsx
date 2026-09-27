'use client';

import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { listSavedSearches } from '../../lib/api/saved-searches';
import {
  listSharedSavedSearches,
  shareSavedSearch,
  unshareSavedSearch,
} from '../../lib/api/saved-search-shares';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface SavedSearchShareScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

/**
 * **SRCH saved-search sharing (x272).**
 *
 * The sharing half of the saved searches (x214, `SavedSearchesScreen`): a member shares one of their
 * own saved searches with the whole studio so teammates can run it, and unshares it again, and
 * everyone sees a "Shared with team" list.
 *
 * Sharing is owner-only and the API enforces it — an unknown saved search is a 404 and a non-owner is
 * a 403 — so this screen offers the share toggle on the caller's own saved searches and renders the
 * shared list the API returns. A shared search re-runs by opening the search screen at `?q=`.
 */
export function SavedSearchShareScreen({
  organizationSlug,
  organizationName,
  client,
}: SavedSearchShareScreenProps) {
  const api = client ?? browserApiClient();
  const queries = useQueryClient();

  const ownKey = ['saved-searches', organizationSlug];
  const sharedKey = ['shared-saved-searches', organizationSlug];

  const own = useQuery({
    queryKey: ownKey,
    queryFn: () => listSavedSearches(api, organizationSlug),
  });
  const shared = useQuery({
    queryKey: sharedKey,
    queryFn: () => listSharedSavedSearches(api, organizationSlug),
  });

  const share = useMutation({
    mutationFn: (savedSearchId: string) => shareSavedSearch(api, organizationSlug, savedSearchId),
    onSuccess: () => {
      void queries.invalidateQueries({ queryKey: sharedKey });
    },
  });
  const unshare = useMutation({
    mutationFn: (savedSearchId: string) => unshareSavedSearch(api, organizationSlug, savedSearchId),
    onSuccess: () => {
      void queries.invalidateQueries({ queryKey: sharedKey });
    },
  });

  const ownList = own.data ?? [];
  const sharedList = shared.data ?? [];
  const sharedIds = new Set(sharedList.map((item) => item.id));

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      title="Shared searches"
      description="Share a saved search with your team, and see the ones your team has shared."
    >
      <section className="tm-panel tm-stack" aria-labelledby="tm-share-own">
        <h2 id="tm-share-own" className="tm-eyebrow">
          Your saved searches
        </h2>
        {own.isError ? (
          <InlineAlert tone="danger" title="Could not load your saved searches" live>
            {describeError(own.error)}
          </InlineAlert>
        ) : null}
        {own.isPending ? (
          <LoadingRegion label="Loading your saved searches.">
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}
        {!own.isPending && !own.isError && ownList.length === 0 ? (
          <InlineAlert tone="neutral" title="No saved searches yet">
            Save a search first, then share it with your team here.
          </InlineAlert>
        ) : null}
        {ownList.length > 0 ? (
          <ul className="tm-stack tm-list" aria-label="Your saved searches">
            {ownList.map((item) => {
              const isShared = sharedIds.has(item.id);
              return (
                <li key={item.id} className="tm-row">
                  <span>{item.name}</span> <span className="tm-muted">“{item.query}”</span>{' '}
                  {isShared ? (
                    <Button
                      type="button"
                      tone="outline"
                      size="accessible"
                      onClick={() => unshare.mutate(item.id)}
                      disabled={unshare.isPending}
                    >
                      Stop sharing
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      size="accessible"
                      onClick={() => share.mutate(item.id)}
                      disabled={share.isPending}
                    >
                      Share with team
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        ) : null}
        {share.isError ? (
          <InlineAlert tone="danger" title="Could not share the search" live>
            {describeError(share.error)}
          </InlineAlert>
        ) : null}
        {unshare.isError ? (
          <InlineAlert tone="danger" title="Could not stop sharing the search" live>
            {describeError(unshare.error)}
          </InlineAlert>
        ) : null}
      </section>

      <section className="tm-panel tm-stack" aria-labelledby="tm-share-team">
        <h2 id="tm-share-team" className="tm-eyebrow">
          Shared with team
        </h2>
        {shared.isError ? (
          <InlineAlert tone="danger" title="Could not load the team’s shared searches" live>
            {describeError(shared.error)}
          </InlineAlert>
        ) : null}
        {shared.isPending ? (
          <LoadingRegion label="Loading the team’s shared searches.">
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}
        {!shared.isPending && !shared.isError && sharedList.length === 0 ? (
          <InlineAlert tone="neutral" title="Nothing shared yet">
            When someone shares a saved search, it shows up here for the whole team.
          </InlineAlert>
        ) : null}
        {sharedList.length > 0 ? (
          <ul className="tm-stack tm-list" aria-label="Searches shared with your team">
            {sharedList.map((item) => (
              <li key={item.id} className="tm-row">
                <Link href={`/${organizationSlug}/search?q=${encodeURIComponent(item.query)}`}>
                  {item.name}
                </Link>{' '}
                <span className="tm-muted">“{item.query}”</span>
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

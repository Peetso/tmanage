'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { browserApiClient } from '../../lib/api/browser-client';
import { getRecentItems } from '../../lib/api/home';
import type { RecentItemObjectType } from '../../lib/api/home';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface HomeRecentItemsViewProps {
  organizationSlug: string;
  client?: ApiClient | undefined;
}

/**
 * **HOME recents (x324)** — the "Recently viewed" rail on Home, additive and disjoint from the x144
 * Pinned section and the older Saved (`saved_context`) section it sits beside.
 *
 * A faithful reader of the API's membership-scoped recents: it reads `GET .../home/recent-items`
 * (behind `work.read`, taking no membership id — the recents are the acting member's own) and lists
 * each one newest first, bounded to the API's fixed cap. A recent is a *reference* — its object kind
 * and id — not a copy or a resolved title, so each row shows the kind and links where a stable route
 * exists (work, project), the read fan-out that resolves a live title being the deferred follow-up.
 * The section is its own landmark (`aria-labelledby`) with a labelled list, so it is axe-clean the
 * way the sibling sections are.
 */
export function HomeRecentItemsView({ organizationSlug, client }: HomeRecentItemsViewProps) {
  const api = client ?? browserApiClient();

  const recents = useQuery({
    queryKey: ['home', 'recent-items', organizationSlug],
    queryFn: () => getRecentItems(api, organizationSlug),
  });

  const items = recents.data?.items ?? [];

  return (
    <section className="tm-panel tm-stack" aria-labelledby="tm-my-day-recents">
      <h2 id="tm-my-day-recents" className="tm-eyebrow">
        Recently viewed
      </h2>

      {recents.isError ? (
        <InlineAlert tone="danger" title="Could not load your recently-viewed items" live>
          {describeRecentsError(recents.error)}
        </InlineAlert>
      ) : null}

      {recents.isPending ? (
        <LoadingRegion label="Loading your recently-viewed items.">
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {!recents.isPending && !recents.isError && items.length === 0 ? (
        <InlineAlert tone="neutral" title="Nothing viewed yet">
          Work, projects, documents and meetings you open are kept here, newest first, so you can
          return to them from any screen.
        </InlineAlert>
      ) : null}

      {items.length > 0 ? (
        <ul className="tm-list" aria-label="Recently viewed">
          {items.map((item) => (
            <li key={item.id}>
              {item.objectType === 'work' ? (
                <Link href={`/${organizationSlug}/work/${item.objectId}`}>
                  {recentTypeLabel(item.objectType)}
                </Link>
              ) : item.objectType === 'project' ? (
                <Link href={`/${organizationSlug}/projects/${item.objectId}`}>
                  {recentTypeLabel(item.objectType)}
                </Link>
              ) : (
                <span>{recentTypeLabel(item.objectType)}</span>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/** The word each recent reference shows. The live title/preview is the deferred read fan-out. */
function recentTypeLabel(objectType: RecentItemObjectType): string {
  switch (objectType) {
    case 'work':
      return 'Recently viewed work item';
    case 'project':
      return 'Recently viewed project';
    case 'document':
      return 'Recently viewed document';
    case 'meeting':
      return 'Recently viewed meeting';
  }
}

function describeRecentsError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) {
    return 'The network dropped before your recently-viewed items loaded.';
  }
  return 'Something went wrong loading your recently-viewed items.';
}

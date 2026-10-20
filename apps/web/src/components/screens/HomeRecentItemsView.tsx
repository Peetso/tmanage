'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import '../../styles/screens/home.css';
import { browserApiClient } from '../../lib/api/browser-client';
import { getRecentItems } from '../../lib/api/home';
import type { RecentItemObjectType } from '../../lib/api/home';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';
import type { MessageKey } from '../../lib/i18n/t';

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
  const t = useT();
  const api = client ?? browserApiClient();

  const recents = useQuery({
    queryKey: ['home', 'recent-items', organizationSlug],
    queryFn: () => getRecentItems(api, organizationSlug),
  });

  const items = recents.data?.items ?? [];

  return (
    <section className="tm-home-saved" aria-labelledby="tm-my-day-recents">
      <div className="tm-home-saved__head">
        <h2 id="tm-my-day-recents" className="tm-home-saved__heading">
          {t('HomeRecentItemsView.heading')}
        </h2>
        {items.length > 0 ? <span className="tm-home-saved__count">{items.length}</span> : null}
      </div>

      {recents.isError ? (
        <InlineAlert tone="danger" title={t('HomeRecentItemsView.loadErrorTitle')} live>
          {describeRecentsError(recents.error)}
        </InlineAlert>
      ) : null}

      {recents.isPending ? (
        <LoadingRegion label={t('HomeRecentItemsView.loading')}>
          <Skeleton height="52px" radius="var(--r-control)" />
        </LoadingRegion>
      ) : null}

      {!recents.isPending && !recents.isError && items.length === 0 ? (
        <p className="tm-home-saved__empty">
          <strong>{t('HomeRecentItemsView.emptyTitle')}</strong>
          {t('HomeRecentItemsView.emptyBody')}
        </p>
      ) : null}

      {items.length > 0 ? (
        <ul className="tm-home-saved__list" aria-label={t('HomeRecentItemsView.listLabel')}>
          {items.map((item) => (
            <li key={item.id} className="tm-home-saved__item" data-kind={item.objectType}>
              <span className="tm-home-orb" aria-hidden="true">
                {recentGlyph(item.objectType)}
              </span>
              <span className="tm-home-saved__text">
                <span className="tm-home-saved__title">
                  {item.objectType === 'work' ? (
                    <Link href={`/${organizationSlug}/work/${item.objectId}`}>
                      {t(recentTypeLabelKey(item.objectType))}
                    </Link>
                  ) : item.objectType === 'project' ? (
                    <Link href={`/${organizationSlug}/projects/${item.objectId}`}>
                      {t(recentTypeLabelKey(item.objectType))}
                    </Link>
                  ) : (
                    <span>{t(recentTypeLabelKey(item.objectType))}</span>
                  )}
                </span>
                <span className="tm-home-saved__meta">
                  {item.objectType} · {t('HomeRecentItemsView.viewedPrefix')}{' '}
                  {shortDay(item.viewedAt)}
                </span>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/** "13 Aug" — the design's short day in the saved-context meta line. */
function shortDay(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? value
    : parsed.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function recentGlyph(objectType: RecentItemObjectType): string {
  switch (objectType) {
    case 'work':
      return '▤';
    case 'project':
      return '◎';
    case 'document':
      return '◫';
    case 'meeting':
      return '◷';
  }
}

/** The message key each recent reference shows. The live title/preview is the deferred read fan-out. */
function recentTypeLabelKey(objectType: RecentItemObjectType): MessageKey {
  switch (objectType) {
    case 'work':
      return 'HomeRecentItemsView.workLabel';
    case 'project':
      return 'HomeRecentItemsView.projectLabel';
    case 'document':
      return 'HomeRecentItemsView.documentLabel';
    case 'meeting':
      return 'HomeRecentItemsView.meetingLabel';
  }
}

function describeRecentsError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) {
    return 'The network dropped before your recently-viewed items loaded.';
  }
  return 'Something went wrong loading your recently-viewed items.';
}

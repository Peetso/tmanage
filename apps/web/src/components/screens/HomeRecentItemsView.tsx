'use client';

import Link from 'next/link';
import { useQueries, useQuery } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import '../../styles/screens/home.css';
import { browserApiClient } from '../../lib/api/browser-client';
import { getRecentItems } from '../../lib/api/home';
import { getWorkItem } from '../../lib/api/work-items';
import { getProject } from '../../lib/api/projects';
import { getDocument } from '../../lib/api/documents';
import type { RecentItemObjectType } from '../../lib/api/home';
import { OFFLINE_LINES, useDescribeApiError } from '../../lib/api/describe-error';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';
import { useTOr } from '../../lib/i18n/use-t-or';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
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
 * and id — so each row's live title is read through the object's own authorized GET (work, project,
 * document), falling back to a generic label when it cannot be read, and links where a route exists.
 * The section is its own landmark (`aria-labelledby`) with a labelled list, so it is axe-clean the
 * way the sibling sections are.
 */
export function HomeRecentItemsView({ organizationSlug, client }: HomeRecentItemsViewProps) {
  const describeRecentsError = useDescribeApiError(OFFLINE_LINES);
  const t = useT();
  const tOr = useTOr();
  const locale = useActiveLocale();
  const api = client ?? browserApiClient();

  const recents = useQuery({
    queryKey: ['home', 'recent-items', organizationSlug],
    queryFn: () => getRecentItems(api, organizationSlug),
  });

  const items = recents.data?.items ?? [];

  // 2026-10-31 live test: every row read "Recently viewed work item". A recent is a reference, so
  // each title is read through the object's own authorized GET (the same read opening it does): a
  // row the caller can no longer reach simply keeps the generic label. Shared query keys mean an
  // item already open elsewhere costs nothing, and a long staleTime keeps the rail cheap.
  const titles = useQueries({
    queries: items.map((item) => ({
      queryKey: ['home', 'recent-title', organizationSlug, item.objectType, item.objectId],
      queryFn: () => recentTitle(api, organizationSlug, item.objectType, item.objectId),
      enabled: item.objectType !== 'meeting',
      staleTime: 5 * 60 * 1000,
      retry: false,
    })),
  });

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
          {items.map((item, index) => {
            const href = recentHref(organizationSlug, item.objectType, item.objectId);
            const title = titles[index]?.data ?? t(recentTypeLabelKey(item.objectType));
            return (
              <li key={item.id} className="tm-home-saved__item" data-kind={item.objectType}>
                <span className="tm-home-orb" aria-hidden="true">
                  {recentGlyph(item.objectType)}
                </span>
                <span className="tm-home-saved__text">
                  <span className="tm-home-saved__title">
                    {href ? <Link href={href}>{title}</Link> : <span>{title}</span>}
                  </span>
                  <span className="tm-home-saved__meta">
                    {tOr(...recentKind(item.objectType))} · {t('HomeRecentItemsView.viewedPrefix')}{' '}
                    {shortDay(item.viewedAt, locale)}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}

/** The route a recent opens, where the object has one. */
function recentHref(
  organizationSlug: string,
  objectType: RecentItemObjectType,
  objectId: string,
): string | null {
  const id = encodeURIComponent(objectId);
  switch (objectType) {
    case 'work':
      return `/${organizationSlug}/work/${id}`;
    case 'project':
      return `/${organizationSlug}/projects/${id}`;
    case 'document':
      return `/${organizationSlug}/docs/${id}`;
    case 'meeting':
      return null;
  }
}

/** The object's live title through its own authorized read; null when it cannot be read. */
async function recentTitle(
  api: ApiClient,
  organizationSlug: string,
  objectType: RecentItemObjectType,
  objectId: string,
): Promise<string | null> {
  try {
    switch (objectType) {
      case 'work':
        return (await getWorkItem(api, organizationSlug, objectId)).title;
      case 'project':
        return (await getProject(api, organizationSlug, objectId)).name;
      case 'document':
        return (await getDocument(api, organizationSlug, objectId)).title;
      case 'meeting':
        return null;
    }
  } catch {
    return null;
  }
}

/** The short kind word on a row's meta line ("Work · viewed 31 Oct"), never the raw enum. */
function recentKind(objectType: RecentItemObjectType): [string, string] {
  switch (objectType) {
    case 'work':
      return ['HomeRecentItemsView.kindWork', 'Work'];
    case 'project':
      return ['HomeRecentItemsView.kindProject', 'Project'];
    case 'document':
      return ['HomeRecentItemsView.kindDocument', 'Doc'];
    case 'meeting':
      return ['HomeRecentItemsView.kindMeeting', 'Meeting'];
  }
}

/** "13 Aug" — the design's short day in the saved-context meta line. */
function shortDay(value: string, locale: string): string {
  const parsed = new Date(value);
  // Latin digits in Arabic, as the Arabic frames write them.
  const tag = locale.toLowerCase().startsWith('ar') ? 'ar-u-nu-latn' : 'en-GB';
  return Number.isNaN(parsed.getTime())
    ? value
    : parsed.toLocaleDateString(tag, { day: 'numeric', month: 'short' });
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

/** The fallback label while a title loads, or when the object can no longer be read. */
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

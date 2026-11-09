'use client';

import { useMemo, useState } from 'react';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Announce, Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { getNotificationsFeed, markNotificationRead } from '../../lib/api/notifications-feed';
import type { NotificationView } from '../../lib/api/notifications-feed';
import { formatInstant } from '../../lib/work-item-presentation';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';
import { translateOr } from '../../lib/i18n/compact-time';
import type { MessageKey } from '../../lib/i18n/t';
import { useDescribeApiError } from '../../lib/api/describe-error';
import '../../styles/screens/home.css';

export interface NotificationsFeedScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

/** One page of the feed — the API clamps and orders; the screen only pages and partitions. */
const FEED_PAGE = 50;

/**
 * **Notifications feed (x151).**
 *
 * `38-MODULE-MAP` §Notifications. The flat, per-notification feed the audit found missing
 * (Notifications *Partial*): where the bundled inbox groups notifications by object for a "what
 * needs doing" surface, this is the raw list a person scans and clears — each row the reference
 * envelope the API echoes (the event in words, what it is about, when), with a "Mark read"
 * button on the unread ones.
 *
 * ## What it draws, and what it cannot
 *
 * - **Two sections, one loaded page set.** The feed is read newest-first over `work.read`; the
 *   loaded items are partitioned into *Unread* and *Read* here, so a reader sees what still
 *   wants attention above what they have already cleared. "Mark read" posts the one id and asks
 *   the feed again — the API reauthorizes and resolves the caller's own row before it writes, so
 *   the screen learns what it decided only by reading.
 * - **The envelope only.** A notification carries no content by NOTIF-001's design; the row
 *   names the event type and the object it is about, not a resolved title. Opening the object is
 *   the inbox's job, which resolves each through its authorized read.
 *
 * Per-kind opt-out is x152; real-time push is NS-13.
 */
export function NotificationsFeedScreen({
  organizationSlug,
  organizationName,
  client,
}: NotificationsFeedScreenProps) {
  const describeError = useDescribeApiError();
  const api = client ?? browserApiClient();
  const t = useT();
  const queryClient = useQueryClient();

  const feed = useInfiniteQuery({
    queryKey: ['notifications-feed', organizationSlug],
    queryFn: ({ pageParam }) =>
      getNotificationsFeed(api, organizationSlug, {
        limit: FEED_PAGE,
        ...(pageParam === undefined ? {} : { before: pageParam }),
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });

  const markRead = useMutation({
    mutationFn: (notificationId: string) =>
      markNotificationRead(api, organizationSlug, notificationId),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['notifications-feed', organizationSlug] }),
  });

  const items = useMemo(() => (feed.data?.pages ?? []).flatMap((page) => page.items), [feed.data]);
  const unread = useMemo(() => items.filter((item) => !item.read), [items]);
  const read = useMemo(() => items.filter((item) => item.read), [items]);
  const [filter, setFilter] = useState<'all' | 'unread' | 'read'>('all');

  const shown = filter === 'unread' ? unread : filter === 'read' ? read : items;

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="inbox"
      eyebrow={t('NotificationsFeedScreen.eyebrow')}
      title={t('NotificationsFeedScreen.title')}
      titleMeta={
        items.length > 0 ? `${unread.length} ${t('NotificationsFeedScreen.unread')}` : undefined
      }
      description={t('NotificationsFeedScreen.description')}
    >
      {feed.isError ? (
        <InlineAlert tone="danger" title={t('NotificationsFeedScreen.loadError')} live>
          {describeError(feed.error)}
        </InlineAlert>
      ) : null}

      {markRead.isError ? (
        <InlineAlert tone="danger" title={t('NotificationsFeedScreen.markError')} live>
          {describeError(markRead.error)}
        </InlineAlert>
      ) : null}

      {items.length > 0 ? (
        <div className="tm-chip-row" role="group" aria-label={t('NotificationsFeedScreen.show')}>
          <button
            type="button"
            className="tm-chip"
            aria-pressed={filter === 'all'}
            onClick={() => setFilter('all')}
          >
            {t('NotificationsFeedScreen.chipAll')} · {items.length}
          </button>
          <button
            type="button"
            className="tm-chip"
            aria-pressed={filter === 'unread'}
            onClick={() => setFilter('unread')}
          >
            {t('NotificationsFeedScreen.chipUnread')} · {unread.length}
          </button>
          <button
            type="button"
            className="tm-chip"
            aria-pressed={filter === 'read'}
            onClick={() => setFilter('read')}
          >
            {t('NotificationsFeedScreen.chipRead')} · {read.length}
          </button>
        </div>
      ) : null}

      {feed.isPending ? (
        <LoadingRegion label={t('NotificationsFeedScreen.loading')}>
          <Skeleton height="44px" />
          <Skeleton height="44px" />
        </LoadingRegion>
      ) : null}

      {!feed.isPending && !feed.isError && items.length === 0 && !feed.hasNextPage ? (
        <div className="tm-card tm-card--empty tm-notif-empty">
          <h2 className="tm-card__title">{t('NotificationsFeedScreen.emptyTitle')}</h2>
          <p className="tm-card__meta">{t('NotificationsFeedScreen.emptyBody')}</p>
        </div>
      ) : null}

      {items.length > 0 ? (
        <div className="tm-notif-table">
          <div className="tm-notif-table__head" aria-hidden="true">
            <span>{t('NotificationsFeedScreen.colEvent')}</span>
            <span>{t('NotificationsFeedScreen.colAbout')}</span>
            <span>{t('NotificationsFeedScreen.colState')}</span>
            <span>{t('NotificationsFeedScreen.colWhen')}</span>
          </div>

          {shown.length === 0 ? (
            <p className="tm-notif-row">
              <span className="tm-notif-row__sub">
                {filter === 'unread'
                  ? t('NotificationsFeedScreen.nothingUnread')
                  : t('NotificationsFeedScreen.nothingReadYet')}
              </span>
            </p>
          ) : null}

          {filter !== 'read' && unread.length > 0 ? (
            <section aria-labelledby="tm-notif-unread">
              <h2 id="tm-notif-unread" className="tm-visually-hidden">
                {t('NotificationsFeedScreen.chipUnread')}
              </h2>
              <ul
                className="tm-notif-list"
                aria-label={t('NotificationsFeedScreen.unreadNotifications')}
              >
                {unread.map((item) => (
                  <li key={item.id} className="tm-notif-row" data-read="false">
                    <div className="tm-notif-row__event">
                      <p className="tm-notif-row__title">
                        <strong>{describeType(item.type, t)}</strong>
                      </p>
                    </div>
                    <span className="tm-notif-row__object">{describeObject(item)}</span>
                    <span className="tm-notif-row__state">
                      <span className="tm-notif-pill" data-tone="unread">
                        {t('NotificationsFeedScreen.unread')}
                      </span>
                    </span>
                    <span className="tm-notif-row__when">
                      <time dateTime={item.createdAt}>{formatWhen(item.createdAt)}</time>
                      <Button
                        tone="outline"
                        size="compact"
                        loading={markRead.isPending && markRead.variables === item.id}
                        loadingLabel={t('NotificationsFeedScreen.markingRead')}
                        aria-label={`${t('NotificationsFeedScreen.markReadColon')} ${describeType(item.type, t)}`}
                        onClick={() => markRead.mutate(item.id)}
                      >
                        {t('NotificationsFeedScreen.markRead')}
                      </Button>
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {filter !== 'unread' && read.length > 0 ? (
            <section aria-labelledby="tm-notif-read">
              <h2 id="tm-notif-read" className="tm-visually-hidden">
                {t('NotificationsFeedScreen.chipRead')}
              </h2>
              <ul
                className="tm-notif-list"
                aria-label={t('NotificationsFeedScreen.readNotifications')}
              >
                {read.map((item) => (
                  <li key={item.id} className="tm-notif-row" data-read="true">
                    <div className="tm-notif-row__event">
                      <p className="tm-notif-row__title">{describeType(item.type, t)}</p>
                      {item.readAt ? (
                        <p className="tm-notif-row__sub">
                          {t('NotificationsFeedScreen.chipRead')} {formatInstant(item.readAt)}
                        </p>
                      ) : null}
                    </div>
                    <span className="tm-notif-row__object">{describeObject(item)}</span>
                    <span className="tm-notif-row__state">
                      <span className="tm-notif-pill">{t('NotificationsFeedScreen.pillRead')}</span>
                    </span>
                    <span className="tm-notif-row__when">
                      <time dateTime={item.createdAt}>{formatWhen(item.createdAt)}</time>
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      ) : null}

      {feed.hasNextPage ? (
        <div className="tm-row">
          <Button
            tone="outline"
            size="accessible"
            loading={feed.isFetchingNextPage}
            loadingLabel={t('NotificationsFeedScreen.loadingMore')}
            onClick={() => void feed.fetchNextPage()}
          >
            {t('NotificationsFeedScreen.loadMore')}
          </Button>
        </div>
      ) : null}

      {/* WCAG 2.2 4.1.3: announce the running total when "Load more" adds rows. */}
      <Announce
        message={
          (feed.data?.pages.length ?? 0) > 1 && !feed.isFetchingNextPage
            ? `${items.length} ${items.length === 1 ? t('NotificationsFeedScreen.notification') : t('NotificationsFeedScreen.notifications')} ${t('NotificationsFeedScreen.loadedInTotal')}`
            : ''
        }
      />
    </AppShell>
  );
}

/** "11:02" today, "18 Oct · 11:02" before — IN-06 draws the time in mono at the row end. */
function formatWhen(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return formatInstant(value);
  const time = parsed.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  if (parsed.toDateString() === new Date().toDateString()) return time;
  return `${parsed.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} · ${time}`;
}

/**
 * The event type, said in words. The map covers the types the platform emits today; an
 * unknown identifier falls back to a humanised form rather than a raw wire string, so a new
 * producer never renders `some.event.v1` verbatim.
 */
const TYPE_LABEL_KEYS: Record<string, MessageKey> = {
  'work_item.blocked.v1': 'NotificationsFeedScreen.typeWorkItemBlocked',
  'work_item.assigned.v1': 'NotificationsFeedScreen.typeWorkItemAssigned',
  'client_request.submitted.v1': 'NotificationsFeedScreen.typeClientRequestSubmitted',
  'client_request.transitioned.v1': 'NotificationsFeedScreen.typeClientRequestTransitioned',
  'client_request.reopened.v1': 'NotificationsFeedScreen.typeClientRequestReopened',
  'usage.threshold_reached.v1': 'NotificationsFeedScreen.typeUsageThreshold',
  'message.mentioned.v1': 'NotificationsFeedScreen.typeMessageMentioned',
  'document.mentioned.v1': 'NotificationsFeedScreen.typeDocumentMentioned',
  'document.comment_created.v1': 'NotificationsFeedScreen.typeDocumentCommentCreated',
  'meeting.attendee_invited.v1': 'NotificationsFeedScreen.typeMeetingAttendeeInvited',
  'project.member_added.v1': 'NotificationsFeedScreen.typeProjectMemberAdded',
  'work_item.people_assigned.v1': 'NotificationsFeedScreen.typePeopleAssigned',
  'work_item.supervised_done.v1': 'NotificationsFeedScreen.typeSupervisedDone',
  'automation.notified.v1': 'NotificationsFeedScreen.typeAutomationNotified',
  'automation.test_run.v1': 'NotificationsFeedScreen.typeAutomationTestRun',
  'review.comment_added.v1': 'NotificationsFeedScreen.typeReviewComment',
  'review.replied.v1': 'NotificationsFeedScreen.typeReviewReplied',
  'review.mentioned.v1': 'NotificationsFeedScreen.typeReviewMentioned',
  'review.thread_resolved.v1': 'NotificationsFeedScreen.typeReviewResolved',
  'review.thread_reopened.v1': 'NotificationsFeedScreen.typeReviewReopened',
  'review.approved.v1': 'NotificationsFeedScreen.typeReviewApproved',
  'review.changes_requested.v1': 'NotificationsFeedScreen.typeReviewChangesRequested',
};

/** Fix 2026-11-09: labels whose keys arrive through an i18n fragment (English until the merge). */
const TYPE_LABEL_FALLBACKS: Record<string, { readonly key: string; readonly english: string }> = {
  'meeting.attendee_responded.v1': {
    key: 'NotificationsFeedScreen.typeMeetingAttendeeResponded',
    english: 'Meeting answer from a calendar',
  },
};

function describeType(type: string, t: (key: MessageKey) => string): string {
  const key = TYPE_LABEL_KEYS[type];
  if (key) return t(key);
  const fallback = TYPE_LABEL_FALLBACKS[type];
  if (fallback) return translateOr(fallback.key, fallback.english);
  // Humanise `some.event.v1` → "Some event": drop a trailing version, split on dots.
  const withoutVersion = type.replace(/\.v\d+$/, '');
  const words = withoutVersion.replace(/[._]/g, ' ').trim();
  return words.length > 0 ? words.charAt(0).toUpperCase() + words.slice(1) : 'Notification';
}

/** What the notification is about, in words — the object kind, humanised, never the tenant id. */
function describeObject(item: NotificationView): string {
  // R4 slice 12: a file under review is a "File" to the reader, never its table name.
  if (item.objectType === 'file_asset') return translateOr('InboxScreen.kindFile', 'File');
  const kind = item.objectType.replace(/[._]/g, ' ');
  return kind.length > 0 ? kind.charAt(0).toUpperCase() + kind.slice(1) : 'Update';
}

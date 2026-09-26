'use client';

import { useMemo } from 'react';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Announce, Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { getNotificationsFeed, markNotificationRead } from '../../lib/api/notifications-feed';
import type { NotificationView } from '../../lib/api/notifications-feed';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import { formatInstant } from '../../lib/work-item-presentation';
import type { ApiClient } from '../../lib/api/client';

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
  const api = client ?? browserApiClient();
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

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="inbox"
      title="Notifications"
      description="Everything you have been told, newest first — unread first, then what you have cleared."
    >
      {feed.isError ? (
        <InlineAlert tone="danger" title="Could not load your notifications" live>
          {describeError(feed.error)}
        </InlineAlert>
      ) : null}

      {markRead.isError ? (
        <InlineAlert tone="danger" title="Could not mark that read" live>
          {describeError(markRead.error)}
        </InlineAlert>
      ) : null}

      {feed.isPending ? (
        <LoadingRegion label="Loading your notifications.">
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {!feed.isPending && !feed.isError && items.length === 0 && !feed.hasNextPage ? (
        <InlineAlert tone="neutral" title="Nothing to catch up on">
          <p className="tm-prose">
            When something happens that involves you — a blocker, a mention, an answer — it shows up
            here.
          </p>
        </InlineAlert>
      ) : null}

      {unread.length > 0 ? (
        <section className="tm-panel tm-stack" aria-labelledby="tm-notif-unread">
          <h2 id="tm-notif-unread" className="tm-eyebrow">
            Unread
          </h2>
          <ul className="tm-stack tm-list" aria-label="Unread notifications">
            {unread.map((item) => (
              <li key={item.id} className="tm-panel tm-stack tm-stack--tight">
                <p className="tm-prose">
                  <strong>{describeType(item.type)}</strong>
                </p>
                <p className="tm-field__hint">
                  {describeObject(item)} · {formatInstant(item.createdAt)}
                </p>
                <div className="tm-row">
                  <Button
                    tone="outline"
                    size="accessible"
                    loading={markRead.isPending && markRead.variables === item.id}
                    loadingLabel="Marking read"
                    aria-label={`Mark read: ${describeType(item.type)}`}
                    onClick={() => markRead.mutate(item.id)}
                  >
                    Mark read
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {read.length > 0 ? (
        <section className="tm-panel tm-stack" aria-labelledby="tm-notif-read">
          <h2 id="tm-notif-read" className="tm-eyebrow">
            Read
          </h2>
          <ul className="tm-stack tm-list" aria-label="Read notifications">
            {read.map((item) => (
              <li key={item.id} className="tm-panel tm-stack tm-stack--tight">
                <p className="tm-prose">{describeType(item.type)}</p>
                <p className="tm-field__hint">
                  {describeObject(item)} · {formatInstant(item.createdAt)}
                  {item.readAt ? ` · Read ${formatInstant(item.readAt)}` : ''}
                </p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {feed.hasNextPage ? (
        <div className="tm-row">
          <Button
            tone="outline"
            size="accessible"
            loading={feed.isFetchingNextPage}
            loadingLabel="Loading more"
            onClick={() => void feed.fetchNextPage()}
          >
            Load more
          </Button>
        </div>
      ) : null}

      {/* WCAG 2.2 4.1.3: announce the running total when "Load more" adds rows. */}
      <Announce
        message={
          (feed.data?.pages.length ?? 0) > 1 && !feed.isFetchingNextPage
            ? `${items.length} ${items.length === 1 ? 'notification' : 'notifications'} loaded in total.`
            : ''
        }
      />
    </AppShell>
  );
}

/**
 * The event type, said in words. The map covers the types the platform emits today; an
 * unknown identifier falls back to a humanised form rather than a raw wire string, so a new
 * producer never renders `some.event.v1` verbatim.
 */
const TYPE_LABELS: Record<string, string> = {
  'work_item.blocked.v1': 'A work item you follow was blocked',
  'work_item.assigned.v1': 'A work item was assigned to you',
  'client_request.submitted.v1': 'A client submitted a request',
  'client_request.transitioned.v1': 'A request you follow changed',
  'usage.threshold_reached.v1': 'Your organization is nearing its storage limit',
};

function describeType(type: string): string {
  const label = TYPE_LABELS[type];
  if (label) return label;
  // Humanise `some.event.v1` → "Some event": drop a trailing version, split on dots.
  const withoutVersion = type.replace(/\.v\d+$/, '');
  const words = withoutVersion.replace(/[._]/g, ' ').trim();
  return words.length > 0 ? words.charAt(0).toUpperCase() + words.slice(1) : 'Notification';
}

/** What the notification is about, in words — the object kind, humanised, never the tenant id. */
function describeObject(item: NotificationView): string {
  const kind = item.objectType.replace(/[._]/g, ' ');
  return kind.length > 0 ? kind.charAt(0).toUpperCase() + kind.slice(1) : 'Update';
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}

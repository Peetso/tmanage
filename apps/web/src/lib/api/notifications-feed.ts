import type { ApiClient } from './client';

/**
 * NOTIF feed (x151) — the flat, per-notification feed.
 *
 * The API serves `GET .../notifications` and `POST .../notifications/:id/read` behind the same
 * `work.read` capability as the notification inbox and preferences. Unlike the bundled inbox,
 * the feed is a flat list of the caller's own notifications — the reference envelope only (type,
 * object reference, read state, time) — that `NotificationsFeedScreen` reads and marks read one
 * item at a time. There is no body on the list and no project id anywhere; the recipient is the
 * authenticated caller, never a value the request names.
 */

/** One notification on the feed — paired Exact with the API's `NotificationView` (contracts gate). */
export interface NotificationView {
  readonly id: string;
  readonly type: string;
  readonly objectType: string;
  readonly objectId: string;
  readonly read: boolean;
  /** An ISO-8601 instant on the wire. */
  readonly createdAt: string;
  readonly readAt: string | null;
}

/** A page of the feed — paired Exact with the API's `NotificationFeedView` (contracts gate). */
export interface NotificationFeedView {
  readonly items: readonly NotificationView[];
  readonly nextCursor: string | null;
}

export interface ListNotificationsQuery {
  readonly before?: string;
  readonly limit?: number;
  readonly unreadOnly?: boolean;
}

export async function getNotificationsFeed(
  client: ApiClient,
  organizationSlug: string,
  query: ListNotificationsQuery = {},
): Promise<NotificationFeedView> {
  const parameters = new URLSearchParams();
  if (query.before) parameters.set('before', query.before);
  if (query.limit !== undefined) parameters.set('limit', String(query.limit));
  if (query.unreadOnly) parameters.set('unread', 'true');
  const suffix = parameters.toString();

  const { data } = await client.request<NotificationFeedView>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/notifications${
      suffix ? `?${suffix}` : ''
    }`,
  });
  return data;
}

export async function markNotificationRead(
  client: ApiClient,
  organizationSlug: string,
  notificationId: string,
): Promise<NotificationView> {
  const { data } = await client.request<NotificationView>({
    method: 'POST',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/notifications/${encodeURIComponent(
      notificationId,
    )}/read`,
  });
  return data;
}

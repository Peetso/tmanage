import type { ApiClient } from './client';

/**
 * The inbox endpoints — INBOX-001's first half, behind `TM-04`.
 *
 * A bundle is one object and every notification about it, resolved by the API through the
 * object's own authorized read at the moment of the request. The screen therefore never
 * receives a notification it may not act on: the API dropped those before answering, and
 * this file has no way to ask for them.
 */

export type InboxMode = 'important' | 'all' | 'waiting_on_me' | 'client_actions';

export interface InboxBundle {
  readonly bundleId: string;
  readonly objectType: 'work_item' | 'client_request';
  readonly objectId: string;
  readonly title: string;
  readonly state: string;
  readonly projectId: string;
  readonly count: number;
  readonly unreadCount: number;
  readonly types: readonly string[];
  readonly latestAt: string;
  readonly action: { readonly kind: 'open' };
}

/**
 * USAGE-001 slice 4b — the organization's storage-usage notice, resolved by the API to the
 * live counters. Owner/admin-only and tenant-scoped; the row carries the numbers the screen
 * renders as "Storage at 85 % — 8.5 GB of 10 GB", not a title of another object.
 */
export interface InboxUsageNotice {
  readonly bundleId: string;
  readonly objectType: 'organization_usage';
  readonly objectId: string;
  readonly band: number;
  readonly used: number;
  readonly reserved: number;
  readonly quota: number;
  readonly count: number;
  readonly unreadCount: number;
  readonly latestAt: string;
}

/** A page item is an object bundle or the organization's usage notice. */
export type InboxItem = InboxBundle | InboxUsageNotice;

export interface InboxPage {
  readonly items: readonly InboxItem[];
  readonly nextCursor: string | null;
}

/** The largest page the API bundles — `MAX_NOTIFICATION_PAGE` in `NotificationsRepository`. */
export const MAX_INBOX_PAGE = 200;

/**
 * The page the screen asks for — `DEFAULT_NOTIFICATION_PAGE`. Every bundle on a page costs
 * the API one authorized read of its object, so the page is the API's default rather than
 * its ceiling; "Load more" is one click away.
 */
export const DEFAULT_INBOX_PAGE = 100;

export interface ListInboxQuery {
  readonly mode?: InboxMode;
  readonly before?: string;
  readonly limit?: number;
}

export async function listInbox(
  client: ApiClient,
  organizationSlug: string,
  query: ListInboxQuery = {},
): Promise<InboxPage> {
  const parameters = new URLSearchParams();
  if (query.mode) parameters.set('mode', query.mode);
  if (query.before) parameters.set('before', query.before);
  if (query.limit !== undefined) parameters.set('limit', String(query.limit));
  const suffix = parameters.size === 0 ? '' : `?${parameters.toString()}`;

  const { data } = await client.request<InboxPage>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/inbox${suffix}`,
  });
  return data;
}

export async function markBundleRead(
  client: ApiClient,
  organizationSlug: string,
  bundleId: string,
): Promise<{ readonly bundleId: string; readonly marked: number }> {
  const { data } = await client.request<{ readonly bundleId: string; readonly marked: number }>({
    method: 'POST',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/inbox/${encodeURIComponent(bundleId)}/read`,
  });
  return data;
}

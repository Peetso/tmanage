import type { ApiClient } from './client';
import { ApiRequestError } from './errors';

/**
 * Platform admin · Content (platform-admin v2 · PA-08, SPEC §5.4 "Content"). Every call needs a
 * live support session for the organization; without one the API answers 428
 * `support_session_required` and the screen shows the inline prompt (436:17010). Each view is
 * paired Exact with the API's in `e2e/contracts/api-web-shapes.ts`.
 */

export interface PlatformContentOrgView {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
}

export interface PlatformContentSessionView {
  readonly id: string;
  readonly adminEmail: string;
  readonly expiresAt: string;
}

export interface PlatformContentCountsView {
  readonly chats: number;
  readonly dms: number;
  readonly workItems: number;
  readonly comments: number;
  readonly docs: number;
  readonly decisions: number;
  readonly meetings: number;
  readonly files: number;
  readonly requests: number;
}

export interface PlatformContentHomeView {
  readonly organization: PlatformContentOrgView;
  readonly session: PlatformContentSessionView;
  readonly counts: PlatformContentCountsView;
  readonly trashCount: number;
}

export interface PlatformContentRowView {
  readonly kind: string;
  readonly id: string;
  readonly parentId: string | null;
  readonly title: string;
  readonly preview: string | null;
  readonly projectId: string | null;
  readonly projectName: string | null;
  readonly authorUserId: string | null;
  readonly authorName: string | null;
  readonly createdAt: string;
  readonly updatedAt: string | null;
  readonly deletedAt: string | null;
  readonly deletedReason: string | null;
  readonly purgeAfter: string | null;
  readonly deletedViaSupport: boolean;
  readonly state: string | null;
  readonly scan: string | null;
  readonly audience: string | null;
  readonly location: string | null;
  readonly sizeBytes: number | null;
  readonly versions: number | null;
  readonly edited: boolean;
  readonly replies: number | null;
  readonly dueAt: string | null;
  readonly sequenceNo: number | null;
}

export interface PlatformContentListView {
  readonly area: string;
  readonly rows: readonly PlatformContentRowView[];
}

export interface PlatformContentMessagesView {
  readonly conversationId: string;
  readonly kind: string;
  readonly messages: readonly PlatformContentRowView[];
}

export interface PlatformContentChangeView {
  readonly field: string;
  readonly before: string | null;
  readonly after: string | null;
  readonly redacted: boolean;
}

export interface PlatformContentHistoryView {
  readonly id: string;
  readonly action: string;
  readonly result: string;
  readonly at: string;
  readonly actorName: string | null;
  readonly viaSupport: boolean;
  readonly supportSessionId: string | null;
  readonly userAgent: string | null;
  readonly changes: readonly PlatformContentChangeView[];
}

export interface PlatformContentLockView {
  /** `version_locked` (approved deliverable version) or `append_only` (said words stay said). */
  readonly code: string;
  readonly approvedAt: string | null;
  readonly approvedByName: string | null;
}

export interface PlatformContentVersionView {
  readonly id: string;
  readonly deliverableId: string;
  readonly deliverableTitle: string;
  readonly versionNo: number;
  readonly fileAssetId: string | null;
  readonly fileName: string | null;
  readonly approvalState: string | null;
  readonly approvedAt: string | null;
  readonly approvedByName: string | null;
  readonly createdAt: string;
}

export interface PlatformContentItemView {
  readonly organization: PlatformContentOrgView;
  readonly item: PlatformContentRowView;
  readonly body: string | null;
  readonly version: number | null;
  readonly editable: readonly string[];
  readonly locked: PlatformContentLockView | null;
  readonly history: readonly PlatformContentHistoryView[];
  readonly deliverableVersions: readonly PlatformContentVersionView[];
  readonly openInApp: string | null;
}

export interface PlatformContentTrashView {
  readonly rows: readonly PlatformContentRowView[];
  readonly purgeDays: number;
}

export interface PlatformContentWriteView {
  readonly item: PlatformContentRowView;
}

/** The B5 area tabs, in the order the frame shows them. */
export const CONTENT_AREAS = [
  'chats',
  'dms',
  'work_items',
  'comments',
  'docs',
  'decisions',
  'meetings',
  'files',
  'requests',
] as const;
export type ContentArea = (typeof CONTENT_AREAS)[number];

export const AREA_COUNT_KEY: Record<ContentArea, keyof PlatformContentCountsView> = {
  chats: 'chats',
  dms: 'dms',
  work_items: 'workItems',
  comments: 'comments',
  docs: 'docs',
  decisions: 'decisions',
  meetings: 'meetings',
  files: 'files',
  requests: 'requests',
};

/** The kinds the API's edit accepts; every other kind is append-only (409). */
export const EDITABLE_KINDS: readonly string[] = [
  'message',
  'work_item',
  'doc',
  'decision',
  'meeting',
];

const COMMENT_ROUTE: Record<string, string> = {
  work_comment: 'work',
  doc_comment: 'doc',
  decision_comment: 'decision',
  file_comment: 'file',
  request_comment: 'request',
  update_comment: 'update',
};

/** True for the 428 the API answers when no support session is live for the organization. */
export function isSupportSessionRequired(error: unknown): boolean {
  return error instanceof ApiRequestError && error.status === 428;
}

function base(organizationId: string): string {
  return `/v1/platform/organizations/${encodeURIComponent(organizationId)}/content`;
}

/** The item route of one kind (GET / PATCH / DELETE; `/restore` appended for restore). */
export function contentItemPath(organizationId: string, kind: string, id: string): string {
  const root = base(organizationId);
  const itemId = encodeURIComponent(id);
  switch (kind) {
    case 'message':
      return `${root}/messages/${itemId}`;
    case 'direct_message':
      return `${root}/messages/${itemId}?kind=dm`;
    case 'work_item':
      return `${root}/work-items/${itemId}`;
    case 'doc':
      return `${root}/docs/${itemId}`;
    case 'decision':
      return `${root}/decisions/${itemId}`;
    case 'meeting':
      return `${root}/meetings/${itemId}`;
    case 'file':
      return `${root}/files/${itemId}`;
    case 'drive_file':
    case 'onedrive_file':
      return `${root}/files/${itemId}?kind=${kind}`;
    case 'request_message':
      return `${root}/request-messages/${itemId}`;
    default: {
      const route = COMMENT_ROUTE[kind];
      if (route) return `${root}/comments/${route}/${itemId}`;
      throw new Error(`Unknown content kind: ${kind}`);
    }
  }
}

function restorePath(organizationId: string, kind: string, id: string): string {
  return `${base(organizationId)}/trash/${encodeURIComponent(kind)}/${encodeURIComponent(id)}/restore`;
}

function withQuery(path: string, params: Record<string, string | null | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && value !== '') search.set(key, value);
  }
  const query = search.toString();
  return query === '' ? path : `${path}${path.includes('?') ? '&' : '?'}${query}`;
}

export async function fetchContentHome(
  client: ApiClient,
  organizationId: string,
): Promise<PlatformContentHomeView> {
  const { data } = await client.request<PlatformContentHomeView>({ path: base(organizationId) });
  return data;
}

export interface ContentListQuery {
  readonly q?: string;
  readonly projectId?: string;
  readonly author?: string;
  readonly deleted?: 'include' | 'only' | 'exclude';
}

const AREA_PATH: Record<ContentArea, string> = {
  chats: 'conversations?kind=channel',
  dms: 'conversations?kind=dm',
  work_items: 'work-items',
  comments: 'comments',
  docs: 'docs',
  decisions: 'decisions',
  meetings: 'meetings',
  files: 'files',
  requests: 'requests',
};

export async function fetchContentList(
  client: ApiClient,
  organizationId: string,
  area: ContentArea,
  filter: ContentListQuery = {},
): Promise<PlatformContentListView> {
  const { data } = await client.request<PlatformContentListView>({
    path: withQuery(`${base(organizationId)}/${AREA_PATH[area]}`, {
      q: filter.q,
      projectId: filter.projectId,
      author: filter.author,
      deleted: filter.deleted,
    }),
  });
  return data;
}

/** A channel's (or DM's, or client request's) messages. */
export async function fetchContentMessages(
  client: ApiClient,
  organizationId: string,
  kind: 'channel' | 'dm' | 'request',
  conversationId: string,
): Promise<PlatformContentMessagesView> {
  const id = encodeURIComponent(conversationId);
  const path =
    kind === 'request'
      ? `${base(organizationId)}/requests/${id}/messages`
      : withQuery(`${base(organizationId)}/conversations/${id}/messages`, {
          kind: kind === 'dm' ? 'dm' : null,
        });
  const { data } = await client.request<PlatformContentMessagesView>({ path });
  return data;
}

export async function fetchContentItem(
  client: ApiClient,
  organizationId: string,
  kind: string,
  id: string,
): Promise<PlatformContentItemView> {
  const { data } = await client.request<PlatformContentItemView>({
    path: contentItemPath(organizationId, kind, id),
  });
  return data;
}

export interface ContentEditInput {
  readonly body?: string;
  readonly title?: string;
  readonly description?: string;
  readonly dueAt?: string | null;
  readonly state?: string;
  readonly rationale?: string;
  readonly agendaNote?: string;
  readonly reason?: string | null;
}

export async function editContentItem(
  client: ApiClient,
  organizationId: string,
  kind: string,
  id: string,
  input: ContentEditInput,
): Promise<PlatformContentWriteView> {
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined && !(key === 'reason' && (value === null || value === ''))) {
      body[key] = value;
    }
  }
  const { data } = await client.request<PlatformContentWriteView>({
    method: 'PATCH',
    path: contentItemPath(organizationId, kind, id),
    body,
  });
  return data;
}

/** Soft delete: the reason is required (SPEC §5.4); members see "Removed by TManage support". */
export async function deleteContentItem(
  client: ApiClient,
  organizationId: string,
  kind: string,
  id: string,
  reason: string,
): Promise<PlatformContentWriteView> {
  const { data } = await client.request<PlatformContentWriteView>({
    method: 'DELETE',
    path: contentItemPath(organizationId, kind, id),
    body: { reason },
  });
  return data;
}

/** Restore through the B7 route, which takes any kind. */
export async function restoreContentItem(
  client: ApiClient,
  organizationId: string,
  kind: string,
  id: string,
  reason: string | null = null,
): Promise<PlatformContentWriteView> {
  const { data } = await client.request<PlatformContentWriteView>({
    method: 'POST',
    path: restorePath(organizationId, kind, id),
    body: reason ? { reason } : {},
  });
  return data;
}

export interface ContentTrashQuery {
  readonly kind?: string;
  readonly actor?: string;
  readonly supportOnly?: boolean;
  readonly q?: string;
}

export async function fetchContentTrash(
  client: ApiClient,
  organizationId: string,
  filter: ContentTrashQuery = {},
): Promise<PlatformContentTrashView> {
  const { data } = await client.request<PlatformContentTrashView>({
    path: withQuery(`${base(organizationId)}/trash`, {
      kind: filter.kind,
      actor: filter.actor,
      q: filter.q,
      supportOnly: filter.supportOnly ? 'true' : null,
    }),
  });
  return data;
}

/** The proxied, audited download (`file_asset.downloaded` with the support session stamped). */
export function contentDownloadUrl(
  baseUrl: string,
  organizationId: string,
  fileId: string,
): string {
  return `${baseUrl}${base(organizationId)}/files/${encodeURIComponent(fileId)}/download`;
}

/** The B6 route of one item. */
export function contentItemHref(organizationId: string, kind: string, id: string): string {
  return `/platform/organizations/${encodeURIComponent(organizationId)}/content/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`;
}

export function contentHomeHref(organizationId: string): string {
  return `/platform/organizations/${encodeURIComponent(organizationId)}/content`;
}

export function contentTrashHref(organizationId: string): string {
  return `${contentHomeHref(organizationId)}/trash`;
}

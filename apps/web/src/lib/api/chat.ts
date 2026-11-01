import type { ApiClient } from './client';

/**
 * R7 slice 2 — the one chat list (`GET …/chat/list`): every channel, group and direct
 * conversation the viewer is a member of, pinned first, then by last message. Pin and archive are
 * the viewer's own marks and change nobody else's list.
 */

export type ChatKind = 'project_channel' | 'group' | 'direct';

export interface ChatLastMessage {
  readonly excerpt: string | null;
  /** `text`, `voice`, `system`, `location`, or `deleted` for a removed message. */
  readonly kind: string;
  /** Null when the viewer wrote it ("You:"). */
  readonly authorName: string | null;
  readonly at: string;
}

export interface ChatListRowData {
  readonly conversationId: string;
  readonly kind: ChatKind;
  readonly title: string;
  readonly projectId: string | null;
  readonly photoFileAssetId: string | null;
  readonly lastMessage: ChatLastMessage | null;
  readonly unreadCount: number;
  readonly pinnedAt: string | null;
  readonly muted: boolean;
  readonly archivedAt: string | null;
  readonly otherUserId: string | null;
}

export interface ChatListResult {
  readonly rows: readonly ChatListRowData[];
  readonly viewerUserId: string | null;
}

function base(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/chat`;
}

export async function fetchChatList(
  client: ApiClient,
  organizationSlug: string,
  options: { readonly includeArchived?: boolean; readonly door?: 'studio' | 'portal' } = {},
): Promise<ChatListResult> {
  const suffix = options.includeArchived === true ? '?include=archived' : '';
  // The portal's list is slice 3's route; it answers the same `rows` shape.
  const path =
    options.door === 'portal'
      ? `/v1/organizations/${encodeURIComponent(organizationSlug)}/portal/chat/list${suffix}`
      : `${base(organizationSlug)}/list${suffix}`;
  const { data } = await client.request<{ rows?: unknown; viewerUserId?: unknown }>({ path });
  return {
    rows: Array.isArray(data?.rows) ? (data.rows as readonly ChatListRowData[]) : [],
    viewerUserId: typeof data?.viewerUserId === 'string' ? data.viewerUserId : null,
  };
}

export type ChatMark = 'pin' | 'archive';

export async function setChatMark(
  client: ApiClient,
  organizationSlug: string,
  conversationId: string,
  mark: ChatMark,
  on: boolean,
): Promise<ChatListRowData> {
  const { data } = await client.request<ChatListRowData>({
    method: on ? 'PUT' : 'DELETE',
    path: `${base(organizationSlug)}/${encodeURIComponent(conversationId)}/${mark}`,
  });
  return data;
}

export const chatKeys = {
  all: (organizationSlug: string) => ['chat-list', organizationSlug] as const,
  list: (organizationSlug: string, includeArchived: boolean) =>
    ['chat-list', organizationSlug, includeArchived ? 'archived' : 'active'] as const,
};

/** Case- and accent-insensitive "contains" over the title and the last excerpt (as the API's q). */
export function chatRowMatches(row: ChatListRowData, query: string): boolean {
  const fold = (text: string) => text.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase();
  const needle = fold(query.trim());
  if (needle === '') return true;
  return fold(row.title).includes(needle) || fold(row.lastMessage?.excerpt ?? '').includes(needle);
}

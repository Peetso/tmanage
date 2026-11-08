import type { ChatListRowData } from '../../lib/api/chat';
import type { OrganizationSummary } from '../../lib/api/organizations';

/**
 * R38 G1/G2 — pure helpers behind the chat page's workspace tabs and its list sections.
 *
 * G2: the chat page can show another workspace's chats without switching the whole app. The
 * page stays at `/<shell>/chat` (the app's current workspace) and carries the chat workspace as
 * `?ws=<slug>`; every chat request then goes to that slug, under the person's own membership
 * there, so the API decides access exactly as it would after a full switch.
 */

/** The query parameter naming the workspace whose chats are on screen. */
export const CHAT_WORKSPACE_PARAM = 'ws';

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/**
 * The chat workspace a `?ws=` value names, or `undefined` for the app's own workspace. A value
 * that is not slug-shaped, or names the shell workspace itself, is ignored.
 */
export function chatWorkspaceFrom(
  shellSlug: string,
  value: string | readonly string[] | null | undefined,
): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string') return undefined;
  const slug = raw.trim().toLowerCase();
  if (!SLUG.test(slug) || slug === shellSlug) return undefined;
  return slug;
}

/** The chat page (or one conversation) of `chatSlug`, opened inside the `shellSlug` app. */
export function chatHref(shellSlug: string, chatSlug?: string, conversationId?: string): string {
  const path = `/${encodeURIComponent(shellSlug)}/chat${
    conversationId === undefined ? '' : `/${encodeURIComponent(conversationId)}`
  }`;
  return chatSlug === undefined || chatSlug === shellSlug
    ? path
    : `${path}?${CHAT_WORKSPACE_PARAM}=${encodeURIComponent(chatSlug)}`;
}

/**
 * The workspaces offered as tabs: the internal ones the person belongs to and that are not
 * suspended (a client workspace has its own portal chat). The shell workspace comes first.
 */
export function chatWorkspaceTabs(
  organizations: readonly OrganizationSummary[],
  shellSlug: string,
): readonly OrganizationSummary[] {
  const usable = organizations.filter((org) => org.audience === 'internal' && !org.suspended);
  return [
    ...usable.filter((org) => org.slug === shellSlug),
    ...usable.filter((org) => org.slug !== shellSlug),
  ];
}

/** A workspace's unread badge: unread messages in chats that are neither archived nor muted. */
export function workspaceUnread(rows: readonly ChatListRowData[]): number {
  return rows.reduce(
    (sum, row) => (row.archivedAt === null && !row.muted ? sum + row.unreadCount : sum),
    0,
  );
}

export type ChatSectionId = 'general' | 'projects' | 'direct';

export interface ChatSection {
  readonly id: ChatSectionId;
  readonly rows: readonly ChatListRowData[];
}

/**
 * G1: the list in three sections — General (groups linked to no project), Projects (project
 * channels and any group a project owns) and Direct messages — each keeping the list's own order
 * (pinned first, then by last message). Empty sections are left out.
 */
export function sectionChatRows(rows: readonly ChatListRowData[]): readonly ChatSection[] {
  const sectionOf = (row: ChatListRowData): ChatSectionId =>
    row.kind === 'direct' ? 'direct' : row.projectId === null ? 'general' : 'projects';
  const order: readonly ChatSectionId[] = ['general', 'projects', 'direct'];
  return order
    .map((id) => ({ id, rows: rows.filter((row) => sectionOf(row) === id) }))
    .filter((section) => section.rows.length > 0);
}

/** "New group" for the chat workspace on screen, keeping `?ws=` when it is not the shell's. */
export function newGroupHref(shellSlug: string, chatSlug?: string): string {
  const base = chatHref(shellSlug, chatSlug);
  return `${base}${base.includes('?') ? '&' : '?'}new=group`;
}

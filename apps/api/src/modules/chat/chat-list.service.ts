import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { ChatListDbRow, ChatListRepository } from './chat-list.repository.js';

/** One row of the chat list (R7 F1). Dates are ISO strings. */
export interface ChatListRowView {
  readonly conversationId: string;
  readonly kind: 'project_channel' | 'group' | 'direct';
  readonly title: string;
  readonly projectId: string | null;
  readonly photoFileAssetId: string | null;
  readonly lastMessage: {
    readonly excerpt: string | null;
    readonly kind: string;
    readonly authorName: string | null;
    readonly at: string;
  } | null;
  readonly unreadCount: number;
  readonly pinnedAt: string | null;
  /** The mute store keeps an on/off flag only, so a mute has no end time: null or never. */
  readonly muted: boolean;
  readonly archivedAt: string | null;
  /** The other person of a direct conversation; null otherwise. */
  readonly otherUserId: string | null;
}

const EXCERPT_LENGTH = 140;

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function toChatListRow(row: ChatListDbRow, viewerUserId: string): ChatListRowView {
  const otherUserId =
    row.kind === 'direct'
      ? row.direct_user_low_id === viewerUserId
        ? row.direct_user_high_id
        : row.direct_user_low_id
      : null;
  const title = row.kind === 'direct' ? (row.other_display_name ?? '') : row.name;
  const lastAt = iso(row.last_created_at);
  const removed = row.last_deleted_at !== null;
  const body = row.last_body ?? '';
  return {
    conversationId: row.conversation_id,
    kind: row.kind,
    title,
    projectId: row.project_id,
    photoFileAssetId: row.photo_file_asset_id,
    lastMessage:
      lastAt === null
        ? null
        : {
            excerpt: removed
              ? null
              : body.length > EXCERPT_LENGTH
                ? `${body.slice(0, EXCERPT_LENGTH)}…`
                : body,
            kind: removed ? 'deleted' : (row.last_kind ?? 'text'),
            authorName: row.last_author_user_id === viewerUserId ? null : row.last_author_name,
            at: lastAt,
          },
    unreadCount: Number(row.unread_count) || 0,
    pinnedAt: iso(row.pinned_at),
    muted: row.muted === true || Number(row.muted) === 1,
    archivedAt: iso(row.archived_at),
    otherUserId,
  };
}

/** Case- and accent-insensitive "contains" over the title and the last excerpt. */
export function matchesSearch(row: ChatListRowView, q: string): boolean {
  const fold = (text: string) => text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
  const needle = fold(q.trim());
  if (needle === '') return true;
  return fold(row.title).includes(needle) || fold(row.lastMessage?.excerpt ?? '').includes(needle);
}

export class ChatListService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly repository: ChatListRepository,
  ) {}

  async list(
    context: TenantContext,
    principal: Principal,
    options: { readonly includeArchived: boolean; readonly q?: string },
  ): Promise<readonly ChatListRowView[]> {
    const rows = await this.database.read(context, (runner) =>
      this.repository.list(runner, context, {
        includeArchived: options.includeArchived,
        hasOrgWideScope: principal.hasOrgWideScope,
      }),
    );
    const views = rows.map((row) => toChatListRow(row, context.userId));
    const q = options.q ?? '';
    return q.trim() === '' ? views : views.filter((row) => matchesSearch(row, q));
  }

  /** Pin or archive for the viewer only; 404 for a conversation not in the viewer's list. */
  async setMark(
    context: TenantContext,
    principal: Principal,
    conversationId: string,
    mark: 'pinned_at' | 'archived_at',
    on: boolean,
  ): Promise<ChatListRowView> {
    return this.database.transaction(context, async (tx) => {
      const query = {
        includeArchived: true,
        hasOrgWideScope: principal.hasOrgWideScope,
        conversationId,
        limit: 1,
      };
      const found = await this.repository.list(tx, context, query);
      if (found.length === 0) throw new ApiError(404, 'not_found', MESSAGES.notFound);
      await this.repository.setMark(tx, context, conversationId, mark, on);
      const after = await this.repository.list(tx, context, query);
      const row = after[0] ?? found[0];
      if (row === undefined) throw new ApiError(404, 'not_found', MESSAGES.notFound);
      return toChatListRow(row, context.userId);
    });
  }
}

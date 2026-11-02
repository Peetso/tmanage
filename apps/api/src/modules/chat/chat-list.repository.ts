import type { QueryRows } from '../../common/database/tenant-context.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * R7 slice 2 — the chat list in one read: every conversation the viewer is a member of (project
 * channels, groups, direct conversations), with its last message, the viewer's unread count, pin,
 * archive and mute.
 *
 * The viewer is the caller and nobody else: the membership join names `context.userId`, the read
 * position and the mute name `context.membershipId`. A project channel also needs the project
 * relation `ConversationsService.mayReach` applies (org-wide scope or a `project_memberships` row),
 * so a stale channel row of someone removed from the project does not list the channel. Groups and
 * direct conversations are member-gated, which the membership join already is.
 *
 * Unread = messages after the viewer's last-read message (by sequence number), top-level, not
 * removed, not the viewer's own. No read row means everything is unread.
 *
 * The unread count is a `LEFT JOIN messages um` + `GROUP BY`, not a scalar subquery in the
 * SELECT list: the tenant guard (enforced in production) cannot see a tenant predicate inside a
 * SELECT-list subquery and rejects the whole statement, which was the live 500 (A1, 2026-11-02).
 * Every other join is at most one row per conversation, so grouping keeps one row each.
 */

export interface ChatListDbRow {
  readonly conversation_id: string;
  readonly kind: 'project_channel' | 'group' | 'direct';
  readonly name: string;
  readonly project_id: string | null;
  readonly photo_file_asset_id: string | null;
  readonly direct_user_low_id: string | null;
  readonly direct_user_high_id: string | null;
  readonly last_message_at: Date | string | null;
  readonly created_at: Date | string;
  readonly pinned_at: Date | string | null;
  readonly archived_at: Date | string | null;
  readonly last_kind: string | null;
  readonly last_body: string | null;
  readonly last_deleted_at: Date | string | null;
  readonly last_created_at: Date | string | null;
  readonly last_author_user_id: string | null;
  readonly last_author_name: string | null;
  readonly other_display_name: string | null;
  readonly muted: number | boolean | null;
  readonly unread_count: number | string;
}

export interface ChatListQuery {
  readonly includeArchived: boolean;
  /** Org-wide principals reach every project channel they are a member of. */
  readonly hasOrgWideScope: boolean;
  /** One conversation only (the pin/archive check); omitted for the whole list. */
  readonly conversationId?: string;
  readonly limit?: number;
}

export const CHAT_LIST_LIMIT = 500;

export function chatListSql(query: ChatListQuery): string {
  return `SELECT c.id AS conversation_id, c.kind, c.name, c.project_id, c.photo_file_asset_id,
          c.direct_user_low_id, c.direct_user_high_id, c.last_message_at, c.created_at,
          cm.pinned_at, cm.archived_at,
          lm.kind AS last_kind, lm.body AS last_body, lm.deleted_at AS last_deleted_at,
          lm.created_at AS last_created_at, lm.author_user_id AS last_author_user_id,
          la.display_name AS last_author_name, ou.display_name AS other_display_name,
          mu.muted AS muted,
          COUNT(um.id) AS unread_count
     FROM conversation_memberships cm
     JOIN conversations c ON c.organization_id = ? AND c.id = cm.conversation_id
     LEFT JOIN messages lm ON lm.organization_id = ? AND lm.id = c.last_message_id
     LEFT JOIN users la ON la.id = lm.author_user_id
     LEFT JOIN users ou ON c.kind = 'direct'
           AND ou.id = CASE WHEN c.direct_user_low_id = ? THEN c.direct_user_high_id
                            ELSE c.direct_user_low_id END
     LEFT JOIN conversation_read_state rs ON rs.organization_id = ? AND rs.conversation_id = c.id
           AND rs.membership_id = ?
     LEFT JOIN messages rm ON rm.organization_id = ? AND rm.id = rs.last_read_message_id
     LEFT JOIN conversation_mutes mu ON mu.organization_id = ? AND mu.conversation_id = c.id
           AND mu.membership_id = ?
     LEFT JOIN messages um ON um.organization_id = ? AND um.conversation_id = c.id
           AND um.parent_message_id IS NULL AND um.deleted_at IS NULL
           AND um.author_user_id <> ?
           AND um.sequence_no > COALESCE(rm.sequence_no, 0)
    WHERE cm.organization_id = ? AND cm.user_id = ?
      AND (c.kind <> 'project_channel' OR ? = 1 OR EXISTS (
            SELECT 1 FROM project_memberships pm
             WHERE pm.organization_id = ? AND pm.project_id = c.project_id AND pm.user_id = ?))
      ${query.includeArchived ? '' : 'AND cm.archived_at IS NULL'}
      ${query.conversationId === undefined ? '' : 'AND c.id = ?'}
    GROUP BY c.id, c.kind, c.name, c.project_id, c.photo_file_asset_id,
             c.direct_user_low_id, c.direct_user_high_id, c.last_message_at, c.created_at,
             cm.id, cm.pinned_at, cm.archived_at,
             lm.id, lm.kind, lm.body, lm.deleted_at, lm.created_at, lm.author_user_id,
             la.display_name, ou.display_name, mu.muted
    ORDER BY (cm.pinned_at IS NULL), cm.pinned_at DESC,
             (c.last_message_at IS NULL), c.last_message_at DESC, c.created_at DESC
    LIMIT ${String(Math.min(Math.max(1, query.limit ?? CHAT_LIST_LIMIT), CHAT_LIST_LIMIT))}`;
}

export function chatListParams(
  context: TenantContext,
  query: ChatListQuery,
): readonly (string | number)[] {
  const org = context.organizationId;
  return [
    org,
    org,
    context.userId,
    org,
    context.membershipId,
    org,
    org,
    context.membershipId,
    org,
    context.userId,
    org,
    context.userId,
    query.hasOrgWideScope ? 1 : 0,
    org,
    context.userId,
    ...(query.conversationId === undefined ? [] : [query.conversationId]),
  ];
}

export class ChatListRepository {
  async list(
    runner: TenantQueryRunner,
    context: TenantContext,
    query: ChatListQuery,
  ): Promise<readonly ChatListDbRow[]> {
    const rows = await runner.query<QueryRows>(chatListSql(query), chatListParams(context, query));
    return rows as unknown as readonly ChatListDbRow[];
  }

  /** Set or clear the viewer's own pin or archive mark. Answers whether a row was touched. */
  async setMark(
    runner: TenantQueryRunner,
    context: TenantContext,
    conversationId: string,
    mark: 'pinned_at' | 'archived_at',
    on: boolean,
  ): Promise<boolean> {
    const result = (await runner.execute(
      `UPDATE conversation_memberships
          SET ${mark === 'pinned_at' ? 'pinned_at' : 'archived_at'} = ${on ? 'current_timestamp(3)' : 'NULL'}
        WHERE organization_id = ? AND conversation_id = ? AND user_id = ?`,
      [context.organizationId, conversationId, context.userId],
    )) as unknown as { affectedRows?: number };
    return (result.affectedRows ?? 0) > 0;
  }
}

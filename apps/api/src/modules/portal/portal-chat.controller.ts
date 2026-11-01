import { Controller, Get, Inject } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { ConversationKind, MessageKind } from '../../common/database/schema.js';
import { PortalChatRepository } from './portal-chat.repository.js';

/** R7 slice 3: the token `ConversationGroupModule` provides `PortalChatService` under. */
export const PORTAL_CHAT_SERVICE = Symbol.for('tmanage.PortalChatService');

const EXCERPT_LENGTH = 120;

/** One chat-list row — the shape of the studio list (R7 slice 2), so `ChatShell` reads both. */
export interface PortalChatRow {
  readonly conversationId: string;
  readonly kind: ConversationKind;
  readonly title: string;
  readonly photoFileAssetId: string | null;
  readonly lastMessage: {
    readonly excerpt: string;
    readonly kind: MessageKind;
    readonly authorName: string;
    readonly at: string;
  } | null;
  readonly unreadCount: number;
  readonly pinnedAt: string | null;
  readonly mutedUntil: string | null;
  readonly archivedAt: string | null;
  readonly otherUserId: string | null;
}

/**
 * R7 slice 3 — the groups a client contact is a member of, and nothing else: never a project
 * channel, never a direct conversation, never a group they are not in. The query is keyed on the
 * principal's own user id, so there is no parameter that could name somebody else's list.
 *
 * Unread counts read the client's own marker (`conversation_read_state.client_membership_id`,
 * 0278).
 */
export class PortalChatService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly repository: PortalChatRepository = new PortalChatRepository(),
  ) {}

  async list(context: TenantContext, principal: Principal): Promise<readonly PortalChatRow[]> {
    return this.database.read(context, async (runner) => {
      const groups = await this.repository.listGroupsForMember(runner, context, principal.userId);
      const last = await this.repository.lastMessages(
        runner,
        context,
        groups.flatMap((g) => (g.lastMessageId ? [g.lastMessageId] : [])),
      );
      const unread = await this.repository.unreadCounts(
        runner,
        context,
        principal.membershipId,
        principal.userId,
        groups.map((g) => g.conversationId),
      );
      const rows = groups.map((group): PortalChatRow => {
        const message = group.lastMessageId ? last.get(group.lastMessageId) : undefined;
        return {
          conversationId: group.conversationId,
          kind: 'group',
          title: group.name,
          photoFileAssetId: group.photoFileAssetId,
          lastMessage:
            message && group.lastMessageAt
              ? {
                  excerpt: message.deleted ? '' : message.body.slice(0, EXCERPT_LENGTH),
                  kind: message.kind,
                  authorName: message.authorName,
                  at: group.lastMessageAt.toISOString(),
                }
              : null,
          unreadCount: unread.get(group.conversationId) ?? 0,
          pinnedAt: group.pinnedAt ? group.pinnedAt.toISOString() : null,
          mutedUntil: null,
          archivedAt: null,
          otherUserId: null,
        };
      });
      // Pinned first, then the order the query gave (newest activity first).
      return [...rows.filter((r) => r.pinnedAt), ...rows.filter((r) => !r.pinnedAt)];
    });
  }
}

/**
 * The portal's chat tab list. Behind `client_projection.read` — the one read every client role
 * holds — rather than `conversation.read`, which the route guard refuses to every client principal
 * (the internal-only ceiling); the member relation that admits a client to a group is applied in
 * the query itself. Messages, attachments and reactions use the conversation routes.
 */
@Controller('v1/organizations/:orgSlug/portal/chat')
export class PortalChatController {
  constructor(@Inject(PORTAL_CHAT_SERVICE) private readonly chat: PortalChatService) {}

  @Get('list')
  @RequireCapability('client_projection.read')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<{ readonly rows: readonly PortalChatRow[]; readonly viewerUserId: string }> {
    return { rows: await this.chat.list(context, principal), viewerUserId: principal.userId };
  }
}

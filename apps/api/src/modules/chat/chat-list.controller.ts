import { Controller, Delete, Get, HttpCode, Inject, Param, Put, Query } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { ChatListRowView, ChatListService } from './chat-list.service.js';

export const CHAT_LIST_SERVICE = Symbol.for('tmanage.ChatListService');

/** The search box's limit; a longer needle matches nothing a title could hold. */
const MAX_QUERY_LENGTH = 120;

/**
 * R7 slice 2 (F1) — the one chat list: channels, groups and direct conversations the viewer is a
 * member of, pinned first, then by last message. Pin and archive are the viewer's own marks on
 * their membership row and touch nobody else's list. The portal lists a client's groups through
 * its own route (slice 3); this one is internal (`conversation.read`).
 */
@Controller('v1/organizations/:orgSlug/chat')
export class ChatListController {
  constructor(@Inject(CHAT_LIST_SERVICE) private readonly chat: ChatListService) {}

  @Get('list')
  @RequireCapability('conversation.read')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Query('include') include?: string,
    @Query('q') q?: string,
  ): Promise<{ readonly rows: readonly ChatListRowView[]; readonly viewerUserId: string }> {
    const rows = await this.chat.list(context, principal, {
      includeArchived: include === 'archived',
      q: typeof q === 'string' ? q.slice(0, MAX_QUERY_LENGTH) : '',
    });
    return { rows, viewerUserId: context.userId };
  }

  @Put(':conversationId/pin')
  @RequireCapability('conversation.read')
  @HttpCode(200)
  pin(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('conversationId') conversationId: string,
  ): Promise<ChatListRowView> {
    return this.chat.setMark(context, principal, conversationId, 'pinned_at', true);
  }

  @Delete(':conversationId/pin')
  @RequireCapability('conversation.read')
  @HttpCode(200)
  unpin(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('conversationId') conversationId: string,
  ): Promise<ChatListRowView> {
    return this.chat.setMark(context, principal, conversationId, 'pinned_at', false);
  }

  @Put(':conversationId/archive')
  @RequireCapability('conversation.read')
  @HttpCode(200)
  archive(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('conversationId') conversationId: string,
  ): Promise<ChatListRowView> {
    return this.chat.setMark(context, principal, conversationId, 'archived_at', true);
  }

  @Delete(':conversationId/archive')
  @RequireCapability('conversation.read')
  @HttpCode(200)
  unarchive(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('conversationId') conversationId: string,
  ): Promise<ChatListRowView> {
    return this.chat.setMark(context, principal, conversationId, 'archived_at', false);
  }
}

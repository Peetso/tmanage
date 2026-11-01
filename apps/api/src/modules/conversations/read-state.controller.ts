import { Body, Controller, Get, HttpCode, Inject, Param, Put } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { CONVERSATION_READ_STATE_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type {
  ConversationReadStateService,
  ConversationReadStateView,
  ConversationUnreadView,
} from './read-state.service.js';

/**
 * Conversation read-state HTTP surface (module CHAT, CH-05, x250).
 *
 * Mounted under the organization slug like the rest of the aggregate, and behind
 * `conversation.read` throughout: the subject is always the authenticated principal's own position,
 * so a read gate is the right one — advancing a read position is a read, not a message. The static
 * `conversations/read-state` collection route is distinct from `conversations/:conversationId` (the
 * router prefers the literal segment), so listing every conversation's unread count does not collide
 * with fetching one conversation.
 */

interface MarkReadBody {
  readonly lastReadMessageId?: unknown;
  readonly lastDeliveredMessageId?: unknown;
}

@Controller('v1/organizations/:orgSlug')
export class ConversationReadStateController {
  constructor(
    @Inject(CONVERSATION_READ_STATE_SERVICE)
    private readonly readState: ConversationReadStateService,
  ) {}

  @Get('conversations/read-state')
  @RequireCapability('conversation.read')
  async listMine(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<{ readonly conversations: readonly ConversationUnreadView[] }> {
    return { conversations: await this.readState.listMine(context, principal) };
  }

  @Get('conversations/:conversationId/read-state')
  @RequireCapability('conversation.read')
  async get(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('conversationId') conversationId: string,
  ): Promise<ConversationReadStateView> {
    return this.readState.get(context, principal, conversationId);
  }

  @Put('conversations/:conversationId/read-state')
  @RequireCapability('conversation.read')
  @HttpCode(200)
  async markRead(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('conversationId') conversationId: string,
    @Body() body: MarkReadBody,
  ): Promise<ConversationReadStateView> {
    const text = (value: unknown): string | undefined =>
      typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
    const lastReadMessageId = text(body?.lastReadMessageId);
    // R7 receipts: a frame fetched while the pane is hidden is delivered, not read.
    const lastDeliveredMessageId = text(body?.lastDeliveredMessageId);
    if (!lastReadMessageId && !lastDeliveredMessageId) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: 'lastReadMessageId', message: 'must be a string' },
      ]);
    }
    if (lastReadMessageId && !lastDeliveredMessageId) {
      return this.readState.markRead(context, principal, conversationId, lastReadMessageId);
    }
    return this.readState.advance(context, principal, conversationId, {
      ...(lastReadMessageId ? { lastReadMessageId } : {}),
      ...(lastDeliveredMessageId ? { lastDeliveredMessageId } : {}),
    });
  }
}

import { Controller, Delete, Get, HttpCode, Inject, Param, Put } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { MESSAGE_PINS_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { MessagePinsService, PinnedMessageView } from './message-pins.service.js';

/**
 * x247's HTTP surface — a conversation's pinned-context list (CH-07 pin / CH-02 pinned context).
 *
 * Mounted under the organization slug like every other route, so `TenantContextGuard` resolves the
 * tenant from the membership row. Three routes:
 *
 * - `PUT …/messages/:messageId/pin` — pin, behind `conversation.moderate`. PUT because it is
 *   idempotent: the same pin twice is one pin, and the response is the pin either way.
 * - `DELETE …/messages/:messageId/pin` — unpin, behind `conversation.moderate`, 204 and idempotent:
 *   unpinning a message that is not pinned is a no-op that still answers 204.
 * - `GET …/pins` — the pinned strip, behind `conversation.read`.
 *
 * The service resolves the conversation and the message tenant-scoped before it authorizes, so a
 * cross-tenant or unknown id is a 404 and a caller without moderation is a 403 — neither reaches a
 * write. The `@RequireCapability` here is the coarse ceiling; the resource-scoped decision is the
 * service's.
 */
@Controller('v1/organizations/:orgSlug')
export class MessagePinsController {
  constructor(@Inject(MESSAGE_PINS_SERVICE) private readonly pins: MessagePinsService) {}

  @Get('conversations/:conversationId/pins')
  @RequireCapability('conversation.read')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('conversationId') conversationId: string,
  ): Promise<{ readonly pins: readonly PinnedMessageView[] }> {
    return { pins: await this.pins.list(context, principal, conversationId) };
  }

  @Put('conversations/:conversationId/messages/:messageId/pin')
  @RequireCapability('conversation.moderate')
  async pin(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('conversationId') conversationId: string,
    @Param('messageId') messageId: string,
  ): Promise<PinnedMessageView> {
    return this.pins.pin(context, principal, conversationId, messageId);
  }

  @Delete('conversations/:conversationId/messages/:messageId/pin')
  @RequireCapability('conversation.moderate')
  @HttpCode(204)
  async unpin(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('conversationId') conversationId: string,
    @Param('messageId') messageId: string,
  ): Promise<void> {
    await this.pins.unpin(context, principal, conversationId, messageId);
  }
}

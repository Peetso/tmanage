import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Put } from '@nestjs/common';
import { Ctx, RequireCapability } from '../../common/http/decorators.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { parseRetentionBody, type AiConversationsService } from './ai-conversations.service.js';

export const AI_CONVERSATIONS_SERVICE = Symbol.for('tmanage.AiConversationsService');

/**
 * 62-13 — the member's own AI conversations and the owner's retention setting.
 *
 * - `GET …/copilot/conversations` and `GET …/conversations/:conversationId`: the caller's own,
 *   newest first; another member's is 404 (`search.use`, like the chat).
 * - `DELETE …/conversations/:conversationId`: deletes it and every message of it (204).
 * - `PUT …/copilot/conversation-retention`: days kept after the last message, 1 to 365
 *   (`org.manage`, audited).
 *
 * Every route here is a NEVER entry of the AI registry: the AI cannot read or delete the member's
 * history, or change how long it is kept.
 */
@Controller('v1/organizations/:orgSlug/copilot')
export class AiConversationsController {
  constructor(@Inject(AI_CONVERSATIONS_SERVICE) private readonly service: AiConversationsService) {}

  @Get('conversations')
  @RequireCapability('search.use')
  list(@Ctx() context: TenantContext) {
    return this.service.list(context);
  }

  @Get('conversations/:conversationId')
  @RequireCapability('search.use')
  get(@Ctx() context: TenantContext, @Param('conversationId') conversationId: string) {
    return this.service.get(context, conversationId);
  }

  @Delete('conversations/:conversationId')
  @HttpCode(204)
  @RequireCapability('search.use')
  async delete(@Ctx() context: TenantContext, @Param('conversationId') conversationId: string) {
    await this.service.delete(context, conversationId);
  }

  @Put('conversation-retention')
  @HttpCode(200)
  @RequireCapability('org.manage')
  setRetention(
    @Ctx() context: TenantContext,
    @Body() body: Readonly<Record<string, unknown>> | null,
  ) {
    return this.service.setRetention(context, parseRetentionBody(body ?? null));
  }
}

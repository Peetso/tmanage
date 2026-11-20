import { Body, Controller, HttpCode, Inject, Param, Post } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { offeredTo } from '../search/commands.controller.js';
import { parseChatBody, type CopilotChatService } from './copilot-chat.service.js';

export const COPILOT_CHAT_SERVICE = Symbol.for('tmanage.CopilotChatService');

/**
 * `POST /v1/organizations/:orgSlug/copilot/chat` — 62-09: one turn of the in-app AI. The gates
 * (member, test list, `copilot` flag, key) are decided in the service before any spend; a
 * workspace without the feature gets 404. `search.use` like the rest of module 16. The route is a
 * NEVER entry of the AI registry: the AI cannot call itself.
 */
@Controller('v1/organizations/:orgSlug/copilot/chat')
export class CopilotChatController {
  constructor(@Inject(COPILOT_CHAT_SERVICE) private readonly service: CopilotChatService) {}

  @Post()
  @HttpCode(200)
  @RequireCapability('search.use')
  chat(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('orgSlug') orgSlug: string,
    @Body() body: Readonly<Record<string, unknown>> | null,
  ) {
    const input = parseChatBody(body ?? null);
    return this.service.chat(context, { orgSlug, commands: offeredTo(principal, context) }, input);
  }
}

import { Body, Controller, Headers, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import {
  Ctx,
  CurrentPrincipal,
  CurrentSession,
  RequireCapability,
} from '../../common/http/decorators.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { AuthenticatedSession } from '../identity/session.service.js';
import { requestState } from '../../common/http/request-state.js';
import { bindChatStepUpSession } from './chat-step-up-session.js';
import { offeredTo } from '../search/commands.controller.js';
import { parseConfirmBody, type AiChangeService } from './ai-change.service.js';
import { parseChatBody, type CopilotChatService } from './copilot-chat.service.js';

export const COPILOT_CHAT_SERVICE = Symbol.for('tmanage.CopilotChatService');
export const AI_CHANGE_SERVICE = Symbol.for('tmanage.AiChangeService');

/**
 * `POST /v1/organizations/:orgSlug/copilot/chat` — 62-09: one turn of the in-app AI. The gates
 * (member, test list, `copilot` flag, key) are decided in the service before any spend; a
 * workspace without the feature gets 404. `search.use` like the rest of module 16.
 *
 * 62-11: `…/chat/confirm` runs a preview card the member confirms (the signed card back, the
 * amounts typed for money, `x-reauth-token` for money and HR); `…/chat/tasks/:taskId/undo` undoes
 * a turn's changes within 15 minutes. Every route here is a NEVER entry of the AI registry: the AI
 * cannot call itself, confirm its own card or undo.
 */
@Controller('v1/organizations/:orgSlug/copilot/chat')
export class CopilotChatController {
  constructor(
    @Inject(COPILOT_CHAT_SERVICE) private readonly service: CopilotChatService,
    @Inject(AI_CHANGE_SERVICE) private readonly changes: AiChangeService,
  ) {}

  @Post()
  @HttpCode(200)
  @RequireCapability('search.use')
  chat(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('orgSlug') orgSlug: string,
    @Body() body: Readonly<Record<string, unknown>> | null,
    @Req() request: object,
    @CurrentSession() session?: AuthenticatedSession,
  ) {
    // ADR-0015 F3: the turn's platform calls are bound to this request's own cookie session.
    bindChatStepUpSession(context, requestState(request)?.authScheme, session?.sessionId);
    const input = parseChatBody(body ?? null);
    return this.service.chat(context, { orgSlug, commands: offeredTo(principal, context) }, input);
  }

  @Post('confirm')
  @HttpCode(200)
  @RequireCapability('search.use')
  confirm(
    @Ctx() context: TenantContext,
    @Param('orgSlug') orgSlug: string,
    @Body() body: Readonly<Record<string, unknown>> | null,
    @Headers('x-reauth-token') reauthToken: string | undefined,
    @Req() request: object,
    @CurrentSession() session?: AuthenticatedSession,
  ) {
    // ADR-0015 F3: a confirmed platform change runs bound to the confirming cookie session.
    bindChatStepUpSession(context, requestState(request)?.authScheme, session?.sessionId);
    return this.changes.confirm(context, orgSlug, parseConfirmBody(body ?? null), {
      reauthToken,
      sessionId: session?.sessionId,
    });
  }

  @Post('tasks/:taskId/undo')
  @HttpCode(200)
  @RequireCapability('search.use')
  undo(
    @Ctx() context: TenantContext,
    @Param('orgSlug') orgSlug: string,
    @Param('taskId') taskId: string,
  ) {
    return this.changes.undo(context, orgSlug, taskId);
  }
}

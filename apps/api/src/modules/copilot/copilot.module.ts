import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import type { ApiConfig } from '../../common/http/api-config.js';
import { API_CONFIG, AUDIT_SERVICE, TENANT_DATABASE } from '../../common/http/tokens.js';
import type { AuditService } from '../audit/audit.service.js';
import { AiAllowanceService } from '../billing/ai-allowance.service.js';
import { AiPacksService } from '../billing/ai-packs.service.js';
import type { InjectCapable } from '../mcp/mcp-endpoint.controller.js';
import {
  PENDING_AI_ACTIONS_SERVICE,
  type PendingAiActionsService,
} from '../mcp/pending-actions.service.js';
import { PlatformAiBudgetSettings } from '../platform-admin/settings/ai-budget.js';
import { AiBudgetRepository } from './ai-budget.repository.js';
import { AiBudgetService } from './ai-budget.service.js';
import { AiChangeService } from './ai-change.service.js';
import {
  AI_CONVERSATIONS_SERVICE,
  AiConversationsController,
} from './ai-conversations.controller.js';
import { AiConversationsService } from './ai-conversations.service.js';
import { platformCapMicroUsd } from './ai-tiers.js';
import {
  AI_CHANGE_SERVICE,
  COPILOT_CHAT_SERVICE,
  CopilotChatController,
} from './copilot-chat.controller.js';
import {
  cardKeyFrom,
  databaseStanding,
  envClients,
  inProcessSurface,
  pendingApprovals,
  pendingFreezer,
} from './copilot-chat.adapters.js';
import { CopilotChatService } from './copilot-chat.service.js';
import { CopilotController } from './copilot.controller.js';

/** The budget the chat runs on and the confirm/undo refunds through (one per module). */
const AI_BUDGET_SERVICE = Symbol.for('tmanage.copilot.AiBudgetService');

/**
 * The AI copilot's wiring — a self-contained module registered from `app.module.ts`.
 *
 * `CopilotController` is the provider-agnostic `ask` shell (offline stub by default). 62-09 adds
 * the orchestrator {@link CopilotChatService} behind `POST …/copilot/chat`, built here over the
 * budget (with the credit packs of 62-07 and the platform admin's settings of 62-08), the
 * allowance resolver, one model client per pool (absent without a key) and the member's tool
 * surface through the in-process API. 62-11 adds {@link AiChangeService} (confirm a preview card,
 * undo a change) over the same budget and surface; cards are signed with a key derived from the
 * session secret, and confirm-class items go through the global pending AI actions service.
 * 62-13 adds {@link AiConversationsService}: the member's own conversations (the chat's history
 * and record port) and the owner's retention setting.
 */
@Module({})
export class CopilotModule {
  static register(): DynamicModule {
    return {
      module: CopilotModule,
      providers: [
        {
          provide: AI_BUDGET_SERVICE,
          inject: [TENANT_DATABASE, AUDIT_SERVICE],
          useFactory: (database: TenantDatabase, audit: AuditService) => {
            const settings = new PlatformAiBudgetSettings();
            const allowance = new AiAllowanceService({
              database,
              poolCapMicroUsd: settings.poolCapMicroUsd,
            });
            return {
              allowance,
              budget: new AiBudgetService({
                database,
                store: new AiBudgetRepository(),
                platformCapMicroUsd: platformCapMicroUsd(process.env),
                packs: new AiPacksService({ database, allowance, audit }),
                settings,
              }),
            };
          },
        },
        {
          provide: AI_CONVERSATIONS_SERVICE,
          inject: [TENANT_DATABASE, AUDIT_SERVICE],
          useFactory: (database: TenantDatabase, audit: AuditService) =>
            new AiConversationsService({ database, standing: databaseStanding(database), audit }),
        },
        {
          provide: COPILOT_CHAT_SERVICE,
          inject: [
            TENANT_DATABASE,
            AI_BUDGET_SERVICE,
            HttpAdapterHost,
            PENDING_AI_ACTIONS_SERVICE,
            AI_CONVERSATIONS_SERVICE,
            { token: API_CONFIG, optional: true },
          ],
          useFactory: (
            database: TenantDatabase,
            wired: { allowance: AiAllowanceService; budget: AiBudgetService },
            host: HttpAdapterHost,
            pending: PendingAiActionsService,
            conversations: AiConversationsService,
            config: ApiConfig | undefined,
          ) => {
            const cardKey = cardKeyFrom(config?.sessionSecret);
            return new CopilotChatService({
              standing: databaseStanding(database),
              allowance: (context) => wired.allowance.forBudget(context),
              budget: wired.budget,
              clientFor: envClients(),
              surface: inProcessSurface(() => host.httpAdapter.getInstance<InjectCapable>()),
              freezeApproval: pendingFreezer(pending),
              conversations,
              ...(cardKey === undefined ? {} : { cardKey }),
            });
          },
        },
        {
          provide: AI_CHANGE_SERVICE,
          inject: [
            TENANT_DATABASE,
            AUDIT_SERVICE,
            AI_BUDGET_SERVICE,
            HttpAdapterHost,
            PENDING_AI_ACTIONS_SERVICE,
            { token: API_CONFIG, optional: true },
          ],
          useFactory: (
            database: TenantDatabase,
            audit: AuditService,
            wired: { budget: AiBudgetService },
            host: HttpAdapterHost,
            pending: PendingAiActionsService,
            config: ApiConfig | undefined,
          ) => {
            const cardKey = cardKeyFrom(config?.sessionSecret);
            return new AiChangeService({
              database,
              standing: databaseStanding(database),
              surface: inProcessSurface(() => host.httpAdapter.getInstance<InjectCapable>()),
              budget: wired.budget,
              audit,
              approvals: pendingApprovals(pending),
              ...(cardKey === undefined ? {} : { cardKey }),
              ...(config?.sessionSecret === undefined
                ? {}
                : { sessionSecret: config.sessionSecret }),
            });
          },
        },
      ],
      controllers: [CopilotController, CopilotChatController, AiConversationsController],
    };
  }
}

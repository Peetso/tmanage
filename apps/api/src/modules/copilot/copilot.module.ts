import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { AUDIT_SERVICE, TENANT_DATABASE } from '../../common/http/tokens.js';
import type { AuditService } from '../audit/audit.service.js';
import { AiAllowanceService } from '../billing/ai-allowance.service.js';
import { AiPacksService } from '../billing/ai-packs.service.js';
import type { InjectCapable } from '../mcp/mcp-endpoint.controller.js';
import { PlatformAiBudgetSettings } from '../platform-admin/settings/ai-budget.js';
import { AiBudgetRepository } from './ai-budget.repository.js';
import { AiBudgetService } from './ai-budget.service.js';
import { platformCapMicroUsd } from './ai-tiers.js';
import { COPILOT_CHAT_SERVICE, CopilotChatController } from './copilot-chat.controller.js';
import { databaseStanding, envClients, inProcessSurface } from './copilot-chat.adapters.js';
import { CopilotChatService } from './copilot-chat.service.js';
import { CopilotController } from './copilot.controller.js';

/**
 * The AI copilot's wiring — a self-contained module registered from `app.module.ts`.
 *
 * `CopilotController` is the provider-agnostic `ask` shell (offline stub by default). 62-09 adds
 * the orchestrator {@link CopilotChatService} behind `POST …/copilot/chat`, built here over the
 * budget (with the credit packs of 62-07 and the platform admin's settings of 62-08), the
 * allowance resolver, one model client per pool (absent without a key) and the member's tool
 * surface through the in-process API.
 */
@Module({})
export class CopilotModule {
  static register(): DynamicModule {
    return {
      module: CopilotModule,
      providers: [
        {
          provide: COPILOT_CHAT_SERVICE,
          inject: [TENANT_DATABASE, AUDIT_SERVICE, HttpAdapterHost],
          useFactory: (database: TenantDatabase, audit: AuditService, host: HttpAdapterHost) => {
            const settings = new PlatformAiBudgetSettings();
            const allowance = new AiAllowanceService({
              database,
              poolCapMicroUsd: settings.poolCapMicroUsd,
            });
            const budget = new AiBudgetService({
              database,
              store: new AiBudgetRepository(),
              platformCapMicroUsd: platformCapMicroUsd(process.env),
              packs: new AiPacksService({ database, allowance, audit }),
              settings,
            });
            return new CopilotChatService({
              standing: databaseStanding(database),
              allowance: (context) => allowance.forBudget(context),
              budget,
              clientFor: envClients(),
              surface: inProcessSurface(() => host.httpAdapter.getInstance<InjectCapable>()),
            });
          },
        },
      ],
      controllers: [CopilotController, CopilotChatController],
    };
  }
}

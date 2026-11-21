import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
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
import { AI_CHANGE_RAN_AT_ONCE_AUDIT_ACTION, AiChangeService } from './ai-change.service.js';
import { DatabaseAiAudit } from './ai-audit.js';
import type { DurableRateLimiter } from '../rate-limits/durable-rate-limiter.js';
import { DURABLE_RATE_LIMITER } from '../rate-limits/durable-throttle.guard.js';
import {
  AI_CHAT_MEMBER_POLICY,
  AI_CHAT_WORKSPACE_POLICY,
} from '../rate-limits/throttle-policies.js';
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
import {
  KNOWLEDGE_INDEX_JOB,
  KnowledgeIndexJob,
  knowledgeIndexEnabled,
} from './knowledge/knowledge-index-job.js';
import { KnowledgeRepository, MariaDbVectorStore } from './knowledge/knowledge.repository.js';
import { KNOWLEDGE_RETRIEVAL, KnowledgeController } from './knowledge/knowledge.controller.js';
import { KnowledgeRetrieval } from './knowledge/knowledge-retrieval.js';
import {
  BUSINESS_MEMORY_SERVICE,
  BusinessMemoryController,
} from './memory/business-memory.controller.js';
import { BusinessMemoryRepository } from './memory/business-memory.repository.js';
import { BusinessMemoryService } from './memory/business-memory.service.js';
import {
  DIGEST_WORDING_JOB,
  DigestWordingJob,
  digestWordingEnabled,
} from './digest/digest-wording-job.js';
import { DigestWordingRepository } from './digest/digest-wording.repository.js';
import { HomeBriefingRepository } from '../home/home-briefing.repository.js';
import { readResolvedFlags } from '../admin/feature-gate.js';

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
        // 62-24: passages for every ready file text, in-process (off unless background work runs
        // here). No embedding provider is wired (no Voyage key): keyword retrieval only.
        {
          provide: KNOWLEDGE_INDEX_JOB,
          inject: [TENANT_DATABASE],
          useFactory: (database: TenantDatabase) =>
            new KnowledgeIndexJob(
              database,
              new KnowledgeRepository(),
              null,
              knowledgeIndexEnabled(),
            ),
        },
        // 62-24: file passages for a member's question (the knowledge route; keyword-only until
        // an embedding provider is configured).
        {
          provide: KNOWLEDGE_RETRIEVAL,
          inject: [TENANT_DATABASE],
          useFactory: (database: TenantDatabase) =>
            new KnowledgeRetrieval(
              database,
              new KnowledgeRepository(),
              new MariaDbVectorStore(),
              null,
            ),
        },
        // 62-28: the optional AI wording of the weekly digest. No batch client exists (no API key),
        // so the job never starts and every digest is the plain template.
        {
          provide: DIGEST_WORDING_JOB,
          inject: [TENANT_DATABASE, AI_BUDGET_SERVICE],
          useFactory: (database: TenantDatabase, ai: { budget: AiBudgetService }) =>
            new DigestWordingJob(
              {
                database,
                repository: new DigestWordingRepository(),
                briefing: new HomeBriefingRepository(),
                budget: ai.budget,
                batch: null,
                flags: (context) => readResolvedFlags(database, context),
              },
              digestWordingEnabled(),
            ),
        },
        // 62-26: Business Memory (approved facts the AI may recall; a person approves).
        {
          provide: BUSINESS_MEMORY_SERVICE,
          inject: [TENANT_DATABASE, AUDIT_SERVICE],
          useFactory: (database: TenantDatabase, audit: AuditService) =>
            new BusinessMemoryService({
              database,
              audit,
              repository: new BusinessMemoryRepository(),
            }),
        },
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
            AUDIT_SERVICE,
            { token: API_CONFIG, optional: true },
            { token: DURABLE_RATE_LIMITER, optional: true },
          ],
          useFactory: (
            database: TenantDatabase,
            wired: { allowance: AiAllowanceService; budget: AiBudgetService },
            host: HttpAdapterHost,
            pending: PendingAiActionsService,
            conversations: AiConversationsService,
            audit: AuditService,
            config: ApiConfig | undefined,
            limiter: DurableRateLimiter | undefined,
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
              audit: new DatabaseAiAudit(database),
              changeAudit: (context: TenantContext, change: { taskId: string; opId: string }) =>
                audit
                  .recordStandalone(context, {
                    action: AI_CHANGE_RAN_AT_ONCE_AUDIT_ACTION,
                    result: 'allowed',
                    objectId: change.taskId,
                    actorUserId: context.userId,
                    metadata: { client_id: 'tmanage-ai', ops: [change.opId] },
                  })
                  .then(() => undefined),
              ...(limiter === undefined
                ? {}
                : {
                    limits: async (context: TenantContext) => {
                      const decision = await limiter.checkAll([
                        { policy: AI_CHAT_MEMBER_POLICY, subject: { token: context.membershipId } },
                        {
                          policy: AI_CHAT_WORKSPACE_POLICY,
                          subject: { token: context.organizationId },
                        },
                      ]);
                      return decision.admitted
                        ? { admitted: true as const }
                        : {
                            admitted: false as const,
                            retryAfterSeconds: decision.retryAfterSeconds,
                          };
                    },
                  }),
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
      controllers: [
        CopilotController,
        CopilotChatController,
        AiConversationsController,
        KnowledgeController,
        BusinessMemoryController,
      ],
    };
  }
}

import { createHmac } from 'node:crypto';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { FeatureFlagsRepository } from '../admin/feature-flags.repository.js';
import { resolveFlags } from '../admin/feature-flags.service.js';
import { liveMcpSurface } from '../mcp/catalog-runtime.js';
import { internalGrants } from '../mcp/internal-grant.js';
import type {
  PendingActionRequester,
  PendingAiActionsService,
} from '../mcp/pending-actions.service.js';
import {
  IN_PROCESS_BASE_URL,
  inProcessFetch,
  type InjectCapable,
} from '../mcp/mcp-endpoint.controller.js';
import { createAiClient, type AiClient } from './ai-client.js';
import { AiChatRepository } from './ai-chat.repository.js';
import type { ChangeApprovals } from './ai-change.service.js';
import type { AiReadiness } from './ai-settings.service.js';
import type { AiSpendingPool } from './ai-tiers.js';
import { tmanageAiStatusOf } from './copilot-chat.service.js';
import type {
  ChatApprovalFreezer,
  ChatStanding,
  ChatSurface,
  ChatSurfaceInput,
  TmanageAiStatus,
} from './copilot-chat.service.js';

/**
 * 62-09 — the production ports of {@link CopilotChatService}: the gates read from the database,
 * one model client per pool from its own key, and the member's tool surface through
 * `liveMcpSurface` with a one-time internal grant per inner call (the MCP module's own
 * confused-deputy rule, architecture B1/B3), attributed to the client `tmanage-ai`.
 */

/** The AI client the inner calls are attributed to in the audit trail and the activity feed. */
export const TMANAGE_AI_CLIENT = { clientId: 'tmanage-ai', clientName: 'TManage AI' } as const;

/**
 * The key of each pool (plan §5: the testing pool runs on its own Anthropic workspace and key).
 * No key = the feature is absent for that pool; the key is never logged or returned.
 */
export const AI_KEY_ENV: Readonly<Record<AiSpendingPool, string>> = {
  customers: 'AI_ANTHROPIC_KEY',
  testing: 'AI_ANTHROPIC_KEY_TESTING',
};

export const AI_CALL_TIMEOUT_MS = 60_000;

/**
 * The key for one pool. The customers pool falls back to the in-app copilot's Anthropic key
 * (`COPILOT_PROVIDER=anthropic` + `COPILOT_API_KEY`), so one key set in hPanel serves both; the
 * testing pool never falls back, so test traffic can only run on its own key.
 */
export function poolKey(
  env: Readonly<Record<string, string | undefined>>,
  pool: AiSpendingPool,
): string {
  const own = env[AI_KEY_ENV[pool]]?.trim() ?? '';
  if (own !== '' || pool !== 'customers') return own;
  const provider = env['COPILOT_PROVIDER']?.trim().toLowerCase();
  return provider === 'anthropic' ? (env['COPILOT_API_KEY']?.trim() ?? '') : '';
}

/** One client per pool, built on first use from the environment; `null` without a key. */
export function envClients(
  env: Readonly<Record<string, string | undefined>> = process.env,
  fetchImpl: typeof fetch = fetch,
): (pool: AiSpendingPool) => AiClient | null {
  const clients = new Map<AiSpendingPool, AiClient | null>();
  return (pool) => {
    if (!clients.has(pool)) {
      const key = poolKey(env, pool);
      clients.set(
        pool,
        key === ''
          ? null
          : createAiClient({ apiKey: key, fetchImpl, timeoutMs: AI_CALL_TIMEOUT_MS }),
      );
    }
    return clients.get(pool) ?? null;
  };
}

/**
 * AI-TWO-WAYS: what the owner's page says about the chat's own gates once the switch is on — the
 * `copilot` module flag first, then this workspace's pool key (the same order as the chat).
 */
export function aiReadiness(
  standing: (context: TenantContext) => Promise<ChatStanding>,
  hasKey: (pool: AiSpendingPool) => boolean = (pool) => poolKey(process.env, pool) !== '',
): (context: TenantContext) => Promise<AiReadiness> {
  return async (context) => {
    const read = await standing(context);
    if (!read.copilotFlag) return 'flag_off';
    return hasKey(read.poolClass) ? 'ready' : 'no_key';
  };
}

/**
 * AI panel (`GET …/ai/panel`): whether TManage AI answers this member, decided by the chat's own
 * gates ({@link tmanageAiStatusOf}) over the same standing read and pool key the chat uses.
 */
export function tmanageAiStatusReader(
  standing: (context: TenantContext) => Promise<ChatStanding>,
  hasKey: (pool: AiSpendingPool) => boolean = (pool) => poolKey(process.env, pool) !== '',
): (context: TenantContext) => Promise<TmanageAiStatus> {
  return async (context) => {
    const read = await standing(context);
    return tmanageAiStatusOf(read, hasKey(read.poolClass));
  };
}

/** The gates: the workspace's AI settings and the `copilot` flag, in one tenant read. */
export function databaseStanding(
  database: Pick<TenantDatabase, 'read'>,
  repository = new AiChatRepository(),
  flags = new FeatureFlagsRepository(),
): (context: TenantContext) => Promise<ChatStanding> {
  return (context) =>
    database.read(context, async (runner) => {
      const settings = await repository.settings(runner, context);
      const copilotFlag = resolveFlags(await flags.list(runner, context)).copilot;
      return { ...settings, copilotFlag };
    });
}

/**
 * The member's tool surface for one task: the compact catalogue's meta-tools run as ordinary
 * in-process requests. Each non-GET inner call carries the tool call's idempotency key.
 */
export function inProcessSurface(
  app: () => InjectCapable,
): (input: ChatSurfaceInput) => ChatSurface {
  return (input) => {
    const { context } = input;
    const base = inProcessFetch(app(), {
      mintGrant: (opId) =>
        internalGrants.mint({
          grantId: input.grantId,
          userId: context.userId,
          membershipId: context.membershipId,
          organizationId: context.organizationId,
          ...TMANAGE_AI_CLIENT,
          opId,
          scopes: input.scopes,
        }),
      correlationId: context.correlationId,
    });
    const keyed: typeof fetch = (target, init) => {
      const key = input.idempotencyKey();
      const method = (init?.method ?? 'GET').toUpperCase();
      if (key === null || method === 'GET') return base(target, init);
      const headers = new Headers(init?.headers);
      headers.set('idempotency-key', key);
      return base(target, { ...init, headers });
    };
    const { catalog, runtime } = liveMcpSurface({
      profile: 'compact',
      scopes: input.scopes,
      capabilities: new Set(context.capabilities),
      orgSlug: input.orgSlug,
      baseUrl: IN_PROCESS_BASE_URL,
      fetch: keyed,
    });
    return {
      async runTool(name, args) {
        const tool = catalog.tools.find((candidate) => candidate.name === name);
        if (tool === undefined) return { isError: true, data: `Unknown tool: ${name}` };
        return runtime.runTool(tool, args);
      },
    };
  };
}

/**
 * 62-11 — the key preview cards are signed with, derived from the session secret for this one
 * purpose (a card never verifies as anything else, and the secret itself never signs a card).
 * `undefined` without a secret: no card is issued and every change is refused.
 */
export function cardKeyFrom(sessionSecret: string | undefined): string | undefined {
  if (sessionSecret === undefined || sessionSecret === '') return undefined;
  return createHmac('sha256', sessionSecret).update('tmanage-ai-card-key:v1').digest('base64url');
}

/** The member and AI client a pending AI action is frozen for and read back as. */
function requesterOf(context: TenantContext): PendingActionRequester {
  return {
    organizationId: context.organizationId,
    membershipId: context.membershipId,
    userId: context.userId,
    ...TMANAGE_AI_CLIENT,
  };
}

/** A confirm-class card item, frozen in `pending_ai_actions` (the MCP approvals' own service). */
export function pendingFreezer(
  service: Pick<PendingAiActionsService, 'request'>,
): ChatApprovalFreezer {
  return async (context, opId, args) =>
    (await service.request(requesterOf(context), opId, args, context.correlationId)).id;
}

/** The confirm of a card approves its confirm-class rows, as the member, once. */
export function pendingApprovals(
  service: Pick<PendingAiActionsService, 'approve' | 'check'>,
): ChangeApprovals {
  return {
    async approve(context, orgSlug, id) {
      await service.approve(context, orgSlug, id);
    },
    outcome: (context, id) => service.check(requesterOf(context), id, context.correlationId),
  };
}

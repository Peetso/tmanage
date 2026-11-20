import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { FeatureFlagsRepository } from '../admin/feature-flags.repository.js';
import { resolveFlags } from '../admin/feature-flags.service.js';
import { liveMcpSurface } from '../mcp/catalog-runtime.js';
import { internalGrants } from '../mcp/internal-grant.js';
import {
  IN_PROCESS_BASE_URL,
  inProcessFetch,
  type InjectCapable,
} from '../mcp/mcp-endpoint.controller.js';
import { createAiClient, type AiClient } from './ai-client.js';
import { AiChatRepository } from './ai-chat.repository.js';
import type { AiSpendingPool } from './ai-tiers.js';
import type { ChatStanding, ChatSurface, ChatSurfaceInput } from './copilot-chat.service.js';

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

/** One client per pool, built on first use from the environment; `null` without a key. */
export function envClients(
  env: Readonly<Record<string, string | undefined>> = process.env,
  fetchImpl: typeof fetch = fetch,
): (pool: AiSpendingPool) => AiClient | null {
  const clients = new Map<AiSpendingPool, AiClient | null>();
  return (pool) => {
    if (!clients.has(pool)) {
      const key = env[AI_KEY_ENV[pool]]?.trim() ?? '';
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

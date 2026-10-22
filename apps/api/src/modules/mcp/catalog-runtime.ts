import type {
  Catalog,
  CatalogProfile,
  CatalogResource,
  CatalogRuntime,
  CatalogTool,
  RunResult,
} from '@tmanage/mcp-server';
import { OPS, findOpById, isNever } from '../ai-actions/registry/index.js';
import type { AiActionOp, AiScope } from '../ai-actions/registry/index.js';
import {
  KNOWN_SCOPES,
  grantCoversScope,
  requiredScopeFor,
  scopesToString,
} from '../oauth/scopes.js';
import {
  allDetailsById,
  buildToolCatalog,
  effectiveScopes,
  toolNameForOp,
} from './tool-catalog.js';
import { buildOpRequest, capResult } from './pending-actions.js';

/**
 * **The live `/mcp` tool surface — the S5 catalogue wired to S6 execution.**
 *
 * The endpoint serves {@link buildToolCatalog} for the caller's grant (filtered by its scopes and
 * the member's capabilities), never a fixed tool set. Every call is checked again here against the
 * grant's scopes with `grantCoversScope` before anything runs (T-SCP-01), and becomes one ordinary
 * in-process REST request built from the registry op: `:orgSlug` is the token's own workspace,
 * never an argument and never looked up through the organization directory (a NEVER route).
 */

/** A personal access token keeps its member's full rights (plan §4.1, "PATs stay"). */
export const PAT_SCOPES: string = scopesToString(KNOWN_SCOPES);

const SHORT_SCOPE: Readonly<Record<string, AiScope>> = {
  'tmanage:read': 'read',
  'tmanage:write': 'write',
  'tmanage:manage': 'manage',
  'tmanage:billing': 'billing',
};

/** The registry scopes a space-delimited OAuth scope string grants (unknown names ignored). */
export function aiScopesOf(scopes: string): AiScope[] {
  return scopes
    .split(/\s+/)
    .map((s) => SHORT_SCOPE[s])
    .filter((s): s is AiScope => s !== undefined);
}

/** Whether a grant covers an op: `manage` implies `write` implies `read`; billing stands apart. */
export function grantCoversOp(scopes: string, op: AiActionOp): boolean {
  const required = requiredScopeFor(op.scope);
  if (required === null) return false;
  const effective = scopesToString(
    [...effectiveScopes(aiScopesOf(scopes))].map((s) => `tmanage:${s}`),
  );
  return grantCoversScope(effective, required);
}

const opByToolName: ReadonlyMap<string, AiActionOp> = new Map(
  OPS.map((op) => [toolNameForOp(op.id), op] as const),
);

/**
 * The ops a JSON-RPC body asks to run (`tools/call` of an op tool, or `tmanage_run_action` naming
 * an op). Used before the transport takes over, so a call outside the grant's scopes answers the
 * HTTP 403 `insufficient_scope` challenge and no inner request is made.
 */
export function opsCalledBy(body: unknown): AiActionOp[] {
  const messages = Array.isArray(body) ? body : [body];
  const ops: AiActionOp[] = [];
  for (const message of messages) {
    const m = message as { method?: unknown; params?: { name?: unknown; arguments?: unknown } };
    if (m?.method !== 'tools/call' || typeof m.params?.name !== 'string') continue;
    const name = m.params.name;
    const actionId =
      name === 'tmanage_run_action'
        ? (m.params.arguments as { action_id?: unknown } | undefined)?.action_id
        : undefined;
    const op = typeof actionId === 'string' ? findOpById(actionId) : opByToolName.get(name);
    if (op !== undefined) ops.push(op);
  }
  return ops;
}

export interface CatalogRuntimeOptions {
  readonly profile: CatalogProfile;
  /** Space-delimited OAuth scopes of the grant (or {@link PAT_SCOPES}). */
  readonly scopes: string;
  readonly capabilities: ReadonlySet<string>;
  /** The token's own workspace. */
  readonly orgSlug: string;
  /** The in-process base the `fetch` answers for. */
  readonly baseUrl: string;
  /** An in-process `fetch` (`inProcessFetch`): strips the client's token, mints a grant, audits. */
  readonly fetch: typeof fetch;
}

/** The catalogue and the runtime that executes it, for one authenticated `/mcp` request. */
export function liveMcpSurface(options: CatalogRuntimeOptions): {
  readonly catalog: Catalog;
  readonly runtime: CatalogRuntime;
} {
  const request = { scopes: aiScopesOf(options.scopes), capabilities: options.capabilities };
  const catalog = buildToolCatalog({ ...request, profile: options.profile });
  // What `find`/`describe`/`run_action` may reach: every op tool the grant may run.
  const permitted = new Map(
    buildToolCatalog({ ...request, profile: 'full' }).tools.map((t) => [t.opId!, t] as const),
  );

  async function runOp(opId: string, args: Record<string, unknown>): Promise<RunResult> {
    const op = findOpById(opId);
    if (op === undefined || isNever(op.method, op.path) || !permitted.has(opId)) {
      return { isError: true, data: `Unknown or not permitted action: ${opId}` };
    }
    if (!grantCoversOp(options.scopes, op)) {
      return { isError: true, data: `insufficient_scope: ${opId} needs ${op.scope}` };
    }
    if (op.risk === 'confirm') {
      return {
        isError: true,
        data: `${opId} needs your approval in TManage and cannot run over this connection yet.`,
      };
    }
    const built = buildOpRequest(op, args, options.orgSlug);
    const response = await options.fetch(`${options.baseUrl}${built.url}`, {
      method: built.method,
      ...(built.body !== undefined
        ? { headers: { 'content-type': 'application/json' }, body: built.body }
        : {}),
    });
    const data = capResult(await response.text());
    if (!response.ok) {
      return { isError: true, data: `The action failed (HTTP ${response.status}).` };
    }
    return { summary: `${permitted.get(opId)!.title} ran.`, data };
  }

  function find(args: Record<string, unknown>): RunResult {
    const words = String(args['query'] ?? '')
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w !== '');
    const limit = typeof args['limit'] === 'number' ? args['limit'] : 20;
    const matches = [...permitted.values()]
      .filter((t) => {
        const text = `${t.opId} ${t.title} ${t.description}`.toLowerCase();
        return words.every((w) => text.includes(w));
      })
      .slice(0, limit)
      .map((t) => ({ action_id: t.opId, title: t.title, description: t.description }));
    return { summary: `${matches.length} matching actions.`, data: { actions: matches } };
  }

  function describe(args: Record<string, unknown>): RunResult {
    const id = String(args['action_id'] ?? '');
    const tool = permitted.get(id);
    const op = findOpById(id);
    if (tool === undefined || op === undefined) {
      return { isError: true, data: `Unknown or not permitted action: ${id}` };
    }
    return {
      summary: tool.title,
      data: {
        action_id: id,
        title: tool.title,
        description: tool.description,
        risk: op.risk,
        arguments: Object.keys(tool.inputSchema),
      },
    };
  }

  const runtime: CatalogRuntime = {
    async runTool(tool: CatalogTool, args: Record<string, unknown>): Promise<RunResult> {
      if (tool.opId !== undefined) return runOp(tool.opId, args);
      switch (tool.name) {
        case 'tmanage_find_actions':
          return find(args);
        case 'tmanage_describe_action':
          return describe(args);
        case 'tmanage_run_action': {
          const id = String(args['action_id'] ?? '');
          const parsed = allDetailsById.get(id)?.input.safeParse(args['args'] ?? {});
          if (parsed === undefined || !permitted.has(id)) {
            return { isError: true, data: `Unknown or not permitted action: ${id}` };
          }
          if (!parsed.success) return { isError: true, data: `Invalid arguments for ${id}.` };
          return runOp(id, parsed.data as Record<string, unknown>);
        }
        default:
          return { isError: true, data: 'Approvals cannot be checked over this connection yet.' };
      }
    },
    async readResource(
      resource: CatalogResource,
      _uri: URL,
      variables: Record<string, string>,
    ): Promise<{ data: unknown }> {
      const result =
        resource.name === 'me-today'
          ? await runOp('home.my_day.list', {})
          : await runOp('projects.get', { projectId: variables['id'] ?? '' });
      if (result.isError) throw new Error(String(result.data));
      return { data: result.data };
    },
  };
  return { catalog, runtime };
}

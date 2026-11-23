import type {
  Catalog,
  CatalogProfile,
  CatalogResource,
  CatalogRuntime,
  CatalogTool,
  RunResult,
} from '@tmanage/mcp-server';
import { rankActions } from './action-search.js';
import {
  OPS,
  callNeedsConfirmWithState,
  findOpById,
  isNever,
} from '../ai-actions/registry/index.js';
import type { AiActionOp, AiScope, StoredFieldLookup } from '../ai-actions/registry/index.js';
import {
  KNOWN_SCOPES,
  grantCoversScope,
  requiredScopeFor,
  scopesToString,
} from '../oauth/scopes.js';
import {
  allDetailsById,
  buildToolCatalog,
  capabilitySatisfied,
  effectiveScopes,
  platformSatisfied,
  toolNameForOp,
} from './tool-catalog.js';
import {
  PendingActionRefusedError,
  approvalMessage,
  approvalUrl,
  buildOpRequest,
  capResult,
  pendingApproval,
} from './pending-actions.js';
import type { PendingActionRequester, PendingAiActionsService } from './pending-actions.service.js';
import { ApiError } from '../../common/http/errors.js';
import { redactFinanceResult } from '../ai-actions/registry/finance-time.js';

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
  /**
   * ADR-0015 part 2: the account's platform permissions, set only when this grant carries a
   * step-up binding (the cookie chat, or an OAuth grant with `tmanage:platform` in its window).
   * `undefined` — always for a personal access token (F2) — lists no `platform.*` op.
   */
  readonly platformPermissions?: ReadonlySet<string>;
  /** The token's own workspace. */
  readonly orgSlug: string;
  /** The in-process base the `fetch` answers for. */
  readonly baseUrl: string;
  /** An in-process `fetch` (`inProcessFetch`): strips the client's token, mints a grant, audits. */
  readonly fetch: typeof fetch;
  /**
   * M01. Reads a stored field for `confirmWhenStored` ops. Defaults to an in-process
   * `GET …/work-items/:id` through {@link fetch} — the member's own tenant-scoped read — so the
   * runtime refuses an edit of a client-visible item before any inner write request is made.
   */
  readonly storedField?: StoredFieldLookup;
  /**
   * S10 / architecture F3. Where a confirm-class call is frozen for approval. Absent (a unit test,
   * or no web origin to link the approve page to), such a call is refused and nothing runs.
   */
  readonly approvals?: McpApprovals;
}

/** What the runtime needs to freeze a confirm-class call and to read its outcome back. */
export interface McpApprovals {
  readonly service: Pick<PendingAiActionsService, 'request' | 'check'>;
  /** The member and AI client the outer request proved — never taken from the AI's arguments. */
  readonly requester: PendingActionRequester;
  /** The web origin the approve page is served from (`WEB_PUBLIC_URL`). */
  readonly webOrigin: string;
  readonly correlationId: string;
}

/** The default M01 lookup: the stored field as the member's own `work_items.get` returns it. */
function storedFieldViaApi(options: CatalogRuntimeOptions): StoredFieldLookup {
  const get = findOpById('work_items.get');
  return async (resource, id, field) => {
    if (resource !== 'work_item' || get === undefined) return undefined;
    const built = buildOpRequest(get, { workItemId: id }, options.orgSlug);
    const response = await options.fetch(`${options.baseUrl}${built.url}`, { method: 'GET' });
    if (!response.ok) return undefined;
    const body = (await response.json()) as Record<string, unknown> | null;
    const value = body?.[field];
    return typeof value === 'string' ? value : undefined;
  };
}

/** The catalogue and the runtime that executes it, for one authenticated `/mcp` request. */
export function liveMcpSurface(options: CatalogRuntimeOptions): {
  readonly catalog: Catalog;
  readonly runtime: CatalogRuntime;
} {
  const request = {
    scopes: aiScopesOf(options.scopes),
    capabilities: options.capabilities,
    ...(options.platformPermissions !== undefined
      ? { platformPermissions: options.platformPermissions }
      : {}),
  };
  const storedField = options.storedField ?? storedFieldViaApi(options);
  const catalog = buildToolCatalog({ ...request, profile: options.profile });
  // What `find`/`describe`/`run_action` may reach: every op tool the grant may run.
  const permitted = new Map(
    buildToolCatalog({ ...request, profile: 'full' }).tools.map((t) => [t.opId!, t] as const),
  );

  /**
   * Why an op the account cannot run here is refused, in words the AI can repeat to the member
   * (owner 2026-11-23: "if he can't do anything let the ai say the reason why"). `null` when the op
   * is runnable. Naming an op that exists reveals nothing: the catalogue is the same for everyone.
   */
  function refusalReason(op: AiActionOp): string | null {
    // ADR-0015 F2: a platform op is never named to an account without platform rights here (a
    // PAT, a non-admin, an OAuth grant outside its window): no reason, so `find` lists nothing.
    if (!platformSatisfied(options.platformPermissions, op)) return null;
    if (isNever(op.method, op.path)) {
      return 'This can only be done by hand in TManage: it needs your own sign-in, password or a file from your device.';
    }
    if (!grantCoversOp(options.scopes, op)) {
      return op.scope === 'read'
        ? 'This AI has no read access here.'
        : `Changes of this kind ("${op.scope}") are switched off for this AI. In TManage AI the workspace owner chose "Answer questions only" (Admin > AI > What TManage AI may do); a connected AI was not given this access when it was connected.`;
    }
    if (!capabilitySatisfied(options.capabilities, op.capability)) {
      return `Your role in this workspace does not have the right "${op.capability}". An owner or admin can give it under Admin > Roles.`;
    }
    return null;
  }

  async function runOp(opId: string, rawArgs: Record<string, unknown>): Promise<RunResult> {
    const op = findOpById(opId);
    if (op === undefined) return { isError: true, data: `Unknown action: ${opId}` };
    if (!permitted.has(opId)) {
      const reason = refusalReason(op) ?? 'This action is not available over this connection.';
      return { isError: true, data: `Not permitted: ${opId}. ${reason}` };
    }
    if (!grantCoversOp(options.scopes, op)) {
      return { isError: true, data: `insufficient_scope: ${opId} needs ${op.scope}` };
    }
    // AI tamper review 2026-11-23 (ASVS 5.0 V2.2, mass assignment): whatever channel called (an op
    // tool, `run_action`, a resource read), the arguments pass the op's own strict schema here, in
    // the one funnel every inner request goes through. Unknown keys are refused, not forwarded.
    const parsed = allDetailsById.get(opId)?.input.safeParse(rawArgs);
    if (parsed === undefined || !parsed.success) {
      return { isError: true, data: `Invalid arguments for ${opId}.` };
    }
    const args = parsed.data as Record<string, unknown>;
    // N07: a `write` op whose arguments reach a client (`confirmWhen`) is refused like a confirm op;
    // M01: so is one on a row the client already sees (`confirmWhenStored`, read from storage).
    if (await callNeedsConfirmWithState(op, args, storedField)) return askApproval(opId, args);
    let built;
    try {
      built = buildOpRequest(op, args, options.orgSlug);
    } catch (error) {
      // A missing or dot-segment path argument: nothing is sent.
      if (error instanceof PendingActionRefusedError) {
        return { isError: true, data: `Invalid arguments for ${opId}.` };
      }
      throw error;
    }
    const response = await options.fetch(`${options.baseUrl}${built.url}`, {
      method: built.method,
      ...(built.body !== undefined
        ? { headers: { 'content-type': 'application/json' }, body: built.body }
        : {}),
    });
    const raw = capResult(await response.text());
    if (!response.ok) {
      return { isError: true, data: `The action failed (HTTP ${response.status}).` };
    }
    // R18-b: the `finance` profile drops cost, margin and bank-detail keys without finance.manage.
    const data =
      allDetailsById.get(opId)?.redact === 'finance'
        ? redactFinanceResult(raw, options.capabilities.has('finance.manage'))
        : raw;
    return { summary: `${permitted.get(opId)!.title} ran.`, data };
  }

  /**
   * A confirm-class call: freeze it as a pending AI action and answer with its approve link, as the
   * personal-access-token route does. Nothing runs until the member approves it in TManage. A
   * `write` op that is confirm-class only for this call (N07 / M01) cannot be frozen
   * (`freezeConfirmAction` takes `confirm` ops), so it stays refused, as on that route.
   */
  async function askApproval(opId: string, args: Record<string, unknown>): Promise<RunResult> {
    const approvals = options.approvals;
    const refused: RunResult = {
      isError: true,
      data: `${opId} needs your approval in TManage and cannot run over this connection yet.`,
    };
    if (approvals === undefined) return refused;
    let created;
    try {
      created = await approvals.service.request(
        approvals.requester,
        opId,
        args,
        approvals.correlationId,
      );
    } catch (error) {
      if (error instanceof PendingActionRefusedError) return refused;
      throw error;
    }
    const url = approvalUrl(approvals.webOrigin, options.orgSlug, created.id);
    return {
      summary: approvalMessage(created.title, url),
      data: pendingApproval({ id: created.id, url, expiresAt: created.expiresAt }),
    };
  }

  /** `tmanage_check_approval`: the outcome of one of this member's own pending actions. */
  async function checkApproval(id: string): Promise<RunResult> {
    const approvals = options.approvals;
    if (approvals === undefined) {
      return { isError: true, data: 'Approvals cannot be checked over this connection yet.' };
    }
    try {
      const outcome = await approvals.service.check(
        approvals.requester,
        id,
        approvals.correlationId,
      );
      return {
        summary: `The approval is ${outcome.status}.`,
        data: {
          approval_id: id,
          status: outcome.status,
          result_status: outcome.resultStatus,
          result: outcome.result,
        },
      };
    } catch (error) {
      // Another member's id answers exactly like one that never existed (T-APR-02).
      if (error instanceof ApiError && error.status === 404) {
        return { isError: true, data: `Unknown approval: ${id}` };
      }
      throw error;
    }
  }

  function find(args: Record<string, unknown>): RunResult {
    const limit = typeof args['limit'] === 'number' ? args['limit'] : 20;
    const searchable = [...permitted.values()].map((t) => ({
      opId: t.opId!,
      title: t.title,
      description: t.description,
    }));
    const query = String(args['query'] ?? '');
    const matches = rankActions(searchable, query, limit).map((t) => ({
      action_id: t.opId,
      title: t.title,
      description: t.description,
    }));
    // Actions that match but this account cannot run here, with the reason, so the AI says why
    // instead of claiming the action does not exist.
    const blocked = rankActions(
      [...allDetailsById.entries()]
        .filter(([opId]) => !permitted.has(opId))
        .map(([opId, detail]) => ({ opId, title: detail.title, description: detail.description })),
      query,
      5,
    ).flatMap((t) => {
      const op = findOpById(t.opId);
      const reason = op === undefined ? null : refusalReason(op);
      return reason === null ? [] : [{ action_id: t.opId, title: t.title, reason }];
    });
    return {
      summary: `${matches.length} matching actions.`,
      data:
        blocked.length === 0 ? { actions: matches } : { actions: matches, not_allowed: blocked },
    };
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
          if (parsed === undefined) return { isError: true, data: `Unknown action: ${id}` };
          // Not runnable here: runOp answers with the reason (owner setting, access, right).
          if (!permitted.has(id)) return runOp(id, {});
          if (!parsed.success) return { isError: true, data: `Invalid arguments for ${id}.` };
          return runOp(id, parsed.data as Record<string, unknown>);
        }
        case 'tmanage_check_approval':
          return checkApproval(String(args['approval_id'] ?? ''));
        default:
          return { isError: true, data: `Unknown or not permitted action: ${tool.name}` };
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

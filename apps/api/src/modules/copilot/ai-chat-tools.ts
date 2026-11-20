import { findOpById } from '../ai-actions/registry/index.js';
import type { AiActionOp } from '../ai-actions/registry/index.js';
import type { AiStrictSchema, AiToolDefinition } from './ai-client.js';
import type { JsonObject } from './ai-response.js';

/**
 * 62-09 (plan 62 §4.1 steps 4–5) — the tools the in-app AI is given in this slice: the four
 * meta-tools of the MCP catalogue (`find`, `describe`, `run_action`, `check_approval`) under strict
 * schemas. The domain packs of 62-10 add direct tools; the meta-tools stay as the long-tail
 * fallback. Each call is translated here into the catalogue tool and arguments `liveMcpSurface`
 * runs (IP-2: parsed once), and two refusals are decided here before anything runs:
 *
 * - **The AI never reaches itself:** an op on the AI's own routes (`/copilot`, `/ai/`) is refused,
 *   so a turn can never start another turn or move its own credits.
 * - **Writes wait for the preview of 62-11:** any op that is not `read` is refused with a calm
 *   "needs your confirmation" result, so this slice can never change data.
 */

export const META_TOOL_NAMES = {
  find: 'tmanage_find_actions',
  describe: 'tmanage_describe_action',
  run: 'tmanage_run_action',
  checkApproval: 'tmanage_check_approval',
} as const;

const strict = (properties: JsonObject): AiStrictSchema => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

export const CHAT_TOOLS: readonly AiToolDefinition[] = [
  {
    name: META_TOOL_NAMES.find,
    description: 'Find TManage actions by words. Returns action ids, titles and descriptions.',
    inputSchema: strict({
      query: { type: 'string' },
      limit: { type: 'integer', minimum: 1, maximum: 20 },
    }),
  },
  {
    name: META_TOOL_NAMES.describe,
    description: 'Describe one TManage action: what it does, its risk and its arguments.',
    inputSchema: strict({ action_id: { type: 'string' } }),
  },
  {
    name: META_TOOL_NAMES.run,
    description:
      'Run one TManage action by id. args_json is a JSON object of its arguments, as described.',
    inputSchema: strict({ action_id: { type: 'string' }, args_json: { type: 'string' } }),
  },
  {
    name: META_TOOL_NAMES.checkApproval,
    description: 'Check the outcome of an approval you asked the member for.',
    inputSchema: strict({ approval_id: { type: 'string' } }),
    // The last tool closes the cached prefix (identical for every workspace).
    cache: '1h',
  },
];

/** The paths of the AI's own surface. An op under them is never run from a turn. */
const SELF_PATH = /\/(copilot|ai)(\/|$)/;

export function isAiSelfOp(op: Pick<AiActionOp, 'path'>): boolean {
  return SELF_PATH.test(op.path);
}

export type ChatToolPlan =
  | {
      readonly kind: 'run';
      /** The catalogue tool name `liveMcpSurface` knows. */
      readonly catalogTool: string;
      readonly args: Record<string, unknown>;
      /** The registry op this call reaches, when it reaches one. */
      readonly opId: string | null;
    }
  | { readonly kind: 'refuse'; readonly opId: string | null; readonly message: string };

const refuse = (opId: string | null, message: string): ChatToolPlan => ({
  kind: 'refuse',
  opId,
  message,
});

/** Turn one model tool call into what runs, or a refusal the model reads as the tool result. */
export function planToolCall(name: string, input: JsonObject): ChatToolPlan {
  switch (name) {
    case META_TOOL_NAMES.find:
      return {
        kind: 'run',
        catalogTool: name,
        args: { query: String(input['query'] ?? ''), limit: Number(input['limit'] ?? 10) },
        opId: null,
      };
    case META_TOOL_NAMES.describe:
      return {
        kind: 'run',
        catalogTool: name,
        args: { action_id: String(input['action_id'] ?? '') },
        opId: null,
      };
    case META_TOOL_NAMES.checkApproval:
      return {
        kind: 'run',
        catalogTool: name,
        args: { approval_id: String(input['approval_id'] ?? '') },
        opId: null,
      };
    case META_TOOL_NAMES.run:
      return planRun(input);
    default:
      return refuse(null, `Unknown tool: ${name}`);
  }
}

function planRun(input: JsonObject): ChatToolPlan {
  const actionId = String(input['action_id'] ?? '');
  const op = findOpById(actionId);
  if (op === undefined) return refuse(null, `Unknown or not permitted action: ${actionId}`);
  if (isAiSelfOp(op)) return refuse(op.id, `Not permitted from the assistant: ${op.id}`);
  if (op.risk !== 'read') {
    return refuse(
      op.id,
      `${op.id} changes data. It needs your confirmation in TManage and was not run.`,
    );
  }
  let args: unknown;
  try {
    args = JSON.parse(String(input['args_json'] ?? '{}'));
  } catch {
    return refuse(op.id, `Invalid arguments for ${op.id}: args_json is not JSON.`);
  }
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    return refuse(op.id, `Invalid arguments for ${op.id}: args_json must be a JSON object.`);
  }
  return {
    kind: 'run',
    catalogTool: META_TOOL_NAMES.run,
    args: { action_id: op.id, args },
    opId: op.id,
  };
}

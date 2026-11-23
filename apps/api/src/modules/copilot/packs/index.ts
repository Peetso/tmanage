import { findOpById } from '../../ai-actions/registry/index.js';
import type { AiActionOp } from '../../ai-actions/registry/index.js';
import { allDetailsById, toolNameForOp } from '../../mcp/tool-catalog.js';
import type { AiToolDefinition } from '../ai-client.js';
import type { AiDomain } from '../ai-router.js';
import { BILLING_PACK_OPS } from './billing.js';
import { packToolSchema } from './pack-schema.js';

/**
 * 62-10 (plan 62 §4.1 step 4) — the domain packs v1: 8 to 15 direct tools per domain, each one
 * registry op, with its strict schema generated from the op's own input schema. The meta-tools
 * (`find` / `describe` / `run_action` / `check_approval`) follow every pack as the long-tail
 * fallback, so an op outside the pack is still reachable, through the same refusals.
 *
 * Packs are constants: the same tools in the same order for every workspace and member (one cached
 * prefix per domain). What a member may actually run is decided at run time by their surface
 * (`liveMcpSurface` + the API's guards), never by which tools were offered. `files` holds the
 * knowledge pack's structured finders (62-22); `billing` is the billing assistant (62-29,
 * `billing.ts`). `help` has no tools.
 *
 * Changes in a pack (`work_items.create`, `work_items.update`, timer start/stop, invitations, a
 * new client company) go through the same preview / confirm / undo path as a `run_action` change
 * (62-11); a `manage` or confirm-class one always on a card.
 */

export const PACK_OPS: Readonly<Partial<Record<AiDomain, readonly string[]>>> = {
  tasks: [
    'home.my_day.list',
    'work_items.list',
    'work_items.get',
    'work_items.subtasks.list',
    'work_items.checklist.list',
    'work_items.comments.list',
    'work_items.blockers.list',
    'work_views.calendar.get',
    'work_items.create',
    'work_items.update',
  ],
  projects: [
    'projects.list',
    'projects.get',
    'projects.summary.get',
    'projects.health.get',
    'projects.milestones.list',
    'projects.members.list',
    'projects.risks.list',
    'projects.status_updates.list',
    'projects.updates.list',
  ],
  people: [
    'people.list',
    'people.get',
    'people.availability.list',
    'people.capacity.list',
    'people.time_off.list',
    'people.teams.list',
    'people.load.get',
    'members.list',
    // Owner 2026-11-23: "invite X as an employee and Y as a client" in one message. The client
    // company is found by name or domain (never invented); the invite is a confirm-class card.
    'client_organizations.list',
    'invitations.list',
    'invitations.create',
  ],
  clients: [
    'client_organizations.list',
    'client_organizations.get',
    'client_organizations.summary.get',
    'client_organizations.projects.list',
    'client_requests.list',
    'client_requests.get',
    'approvals.deliverables.list',
    'quotes.list',
    // Owner 2026-11-23: invite a client contact (the client company's id from the list above);
    // a missing company can be proposed on its own card first ("Invite client" creates it too).
    'invitations.list',
    'invitations.create',
    'client_organizations.create',
  ],
  // 62-22: the knowledge pack's structured finders (level 1, plan §4.4) across clients,
  // projects, files, documents, invoices and quotes; `search_knowledge` (level 2) follows every
  // pack (`knowledge.ts`).
  files: [
    'projects.files.list',
    'work_items.files.list',
    'documents.list',
    'documents.get',
    'client_organizations.list',
    'client_organizations.get',
    'projects.list',
    'projects.get',
    'billing.invoices.list',
    'billing.invoices.get',
    'quotes.list',
  ],
  time: [
    'time.timesheets.mine',
    'time.timesheets.list',
    'time.active.list',
    'time.timer.get',
    'work_items.time_logs.list',
    'finance.expenses.list',
    'time.timer.start',
    'time.timer.stop',
  ],
  // 62-29: invoices, aging, unbilled work, expenses, the pull preview; draft, pull, issue, expense.
  billing: BILLING_PACK_OPS,
};

export const PACK_MIN_TOOLS = 8;
export const PACK_MAX_TOOLS = 15;

/** A pack tool's op: the tool name is the op id with dots as underscores (the MCP names). */
const opByToolName = new Map<string, AiActionOp>();
for (const ids of Object.values(PACK_OPS)) {
  for (const id of ids ?? []) {
    const op = findOpById(id);
    if (op !== undefined) opByToolName.set(toolNameForOp(id), op);
  }
}

/** The registry op a pack tool name stands for, or `undefined` (not a pack tool). */
export function packOpFor(toolName: string): AiActionOp | undefined {
  return opByToolName.get(toolName);
}

function packTool(opId: string): AiToolDefinition {
  const detail = allDetailsById.get(opId);
  if (detail === undefined || findOpById(opId) === undefined) {
    throw new Error(`pack op ${opId} is not in the registry`);
  }
  return {
    name: toolNameForOp(opId),
    description: detail.description,
    inputSchema: packToolSchema(detail.input),
    // Non-strict: the op's own schema validates on the server; strict would spend the request's
    // shared union/optional budget (see pack-schema.ts).
    strict: false,
  };
}

const packCache = new Map<AiDomain, readonly AiToolDefinition[]>();

/** The direct tools of a domain's pack (empty when it has none). Built once, then constant. */
export function packTools(domain: AiDomain): readonly AiToolDefinition[] {
  let tools = packCache.get(domain);
  if (tools === undefined) {
    tools = Object.freeze((PACK_OPS[domain] ?? []).map(packTool));
    packCache.set(domain, tools);
  }
  return tools;
}

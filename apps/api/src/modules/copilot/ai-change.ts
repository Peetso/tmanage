import { findOpById } from '../ai-actions/registry/index.js';
import { subjectLookupOp } from '../mcp/pending-actions.js';
import { META_TOOL_NAMES } from './ai-chat-tools.js';
import { validateChange, type ValidatedChange } from './ai-preview.js';
import { captureUndo, inverseOf, pathArgsOf, recordOf, type AiUndoEntry } from './ai-undo.js';
import type { ChatSurface, ChatToolResult } from './copilot-chat.service.js';

/**
 * 62-11 part 2 — running one AI change through the member's own surface, with its undo captured
 * around it: read the target (an update), run, read it again. The same code runs a change "at
 * once" in a turn and a confirmed card item, so what a card promised is what runs (AR-8).
 *
 * Every call — the reads, the write, the inverse — goes through `liveMcpSurface` as the member
 * under the turn's scopes: the full guard chain, the member's rights, the audit attribution to
 * `tmanage-ai`. A confirm-class op never runs here; its approval runs it (`pending_ai_actions`).
 */

export interface ChangeRun {
  readonly ok: boolean;
  /** The op's answer (capped), shown to the model or returned to the card. */
  readonly result: ChatToolResult;
  /** What the undo needs, or `null`: the change cannot be undone. */
  readonly undo: AiUndoEntry | null;
}

/** Run a registry op through the surface's `run_action`. */
export function runOp(
  surface: ChatSurface,
  opId: string,
  args: Readonly<Record<string, unknown>>,
): Promise<ChatToolResult> {
  return surface.runTool(META_TOOL_NAMES.run, { action_id: opId, args: { ...args } });
}

/** Read a target as the member; `null` when the read fails (the card then shows no "before"). */
export async function readTarget(
  surface: ChatSurface,
  opId: string,
  args: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  const read = await runOp(surface, opId, args);
  return read.isError === true ? null : read.data;
}

/** The current values of an update's target, for its card (`null` for a create or no read). */
export async function currentValues(
  surface: ChatSurface,
  change: ValidatedChange,
): Promise<unknown> {
  // The registry's read of the same path names the target of an update, a delete or an action on
  // one record, whether or not the change has an inverse (`subjectLookupOp`, as the approve page).
  // A create on a collection root (`…/work-items/`) has no target yet: its read is the list.
  if (change.op.method === 'POST' && change.op.path.endsWith('/')) return null;
  const readOp = subjectLookupOp(change.op);
  if (readOp === undefined) return null;
  return readTarget(surface, readOp.id, pathArgsOf(readOp.path, change.args));
}

/**
 * Run one write-class change with its undo captured. `approve` replaces the run for a confirm-class
 * op (its approval runs the frozen op once); the reads around it are the same.
 */
export async function runChange(
  surface: ChatSurface,
  change: ValidatedChange,
  approve?: () => Promise<ChatToolResult>,
): Promise<ChangeRun> {
  const spec = inverseOf(change.op);
  const restoreRead = spec?.kind === 'restore' ? findOpById(spec.readOpId) : undefined;
  const readArgs = restoreRead ? pathArgsOf(restoreRead.path, change.args) : {};
  const before = restoreRead ? await readTarget(surface, restoreRead.id, readArgs) : null;
  const result = approve ? await approve() : await runOp(surface, change.op.id, change.args);
  if (result.isError === true) return { ok: false, result, undo: null };
  let after: unknown = null;
  if (spec !== null) {
    if (spec.kind === 'restore' && restoreRead) {
      after = await readTarget(surface, restoreRead.id, readArgs);
    } else if (spec.kind === 'remove') {
      const created = captureUndo(change.op, spec, change.args, {
        before: null,
        answer: result.data,
        after: null,
      });
      if (created !== null) after = await readTarget(surface, spec.readOpId, created.readArgs);
    }
  }
  const undo = captureUndo(change.op, spec, change.args, { before, answer: result.data, after });
  // An inverse its own op's schema would refuse (a value that was empty) is no undo at all.
  return { ok: true, result, undo: undo !== null && inverseValid(undo) ? undo : null };
}

function inverseValid(entry: AiUndoEntry): boolean {
  return validateChange(entry.inverseOpId, entry.inverseArgs) !== null;
}

/**
 * Whether this change could be undone, judged before it runs from the target's current values: a
 * create with an archive or delete, or an update whose current values its own op can write back.
 */
export function undoPossible(change: ValidatedChange, current: unknown): boolean {
  const spec = inverseOf(change.op);
  if (spec === null) return false;
  if (spec.kind === 'remove') return true;
  // The marker and the version are read after the run; stand-ins take their place here. The
  // version stand-in must be one the op's schema accepts (versions start at 1, DC-9), else every
  // versioned update would read "cannot be undone": the record's own version, else 1.
  const version = recordOf(current)?.['version'];
  const probe = captureUndo(change.op, spec, change.args, {
    before: current,
    answer: null,
    after: { updatedAt: 'probe', version: typeof version === 'number' ? version : 1 },
  });
  return probe !== null && inverseValid(probe);
}

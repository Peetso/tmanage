#!/usr/bin/env node
// Claude Code hook: "read the general standards before you edit code" (PART-DOCS.md §3.3 L2).
//
// Rule (Peter, 2026-11-20: general standards, not a doc for every part):
//   * an edit of a repository file outside docs/ and .claude/ needs docs/architecture/README.md
//     to have been read once in this session (per agent: a subagent needs its own read);
//   * an edit inside a part that HAS a PART.md also needs that PART.md read;
//   * a part without a PART.md never blocks and never reminds.
//
//   node scripts/arch/part-docs-gate.mjs gate     PreToolUse  Edit|Write|MultiEdit|NotebookEdit,
//                                                  and Bash|PowerShell (write targets only)
//   node scripts/arch/part-docs-gate.mjs record   PostToolUse Read (records README/PART.md reads)
//
// Verified hook contract (https://code.claude.com/docs/en/hooks, read 2026-11-20):
//   * stdin JSON carries session_id, transcript_path, cwd, hook_event_name, tool_name,
//     tool_input (file tools: tool_input.file_path, always absolute), and agent_id/agent_type
//     when the hook fires inside a subagent (hooks from settings files run in subagents too).
//   * exit 2 blocks a PreToolUse call and stderr is shown to Claude; exit 0 with no output lets
//     the call continue through the normal permission flow (it does not approve it).
//   * a crash or timeout does not block unless the hook has "onFailure": "block".
//   * the subagent's own transcript is `<session>/subagents/agent-<agent_id>.jsonl`.
//
// A read counts when (a) the PostToolUse(Read) record exists for this session + agent, or
// (b) this agent's transcript holds a Read (or single-file shell read) of the doc. (a) exists
// because the docs say the transcript "is written asynchronously and may lag".
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  ARCH_README,
  DOC_NAME,
  LOADER_NAME,
  REGISTRY_PATH,
  REPO_ROOT,
  agentTranscriptPath,
  findPart,
  repoRelative,
  shellWriteTargets,
  stateShowsRead,
  transcriptShowsRead,
  validateRegistry,
} from './parts-lib.mjs';

export const STATE_PATH = '.claude/state/part-reads.jsonl';
const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);

const readText = (file) => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};

/** Edits that never need a read: PART.md, CLAUDE.md, docs/**, .claude/**, files outside the repo. */
export function isExempt(rel) {
  if (rel == null) return true;
  const base = path.posix.basename(rel);
  return (
    base === DOC_NAME ||
    base === LOADER_NAME ||
    rel.startsWith('docs/') ||
    rel.startsWith('.claude/')
  );
}

/** Docs whose reads the gate records: the architecture README and every PART.md. */
export function isTrackedDoc(rel) {
  return rel === ARCH_README || path.posix.basename(rel ?? '') === DOC_NAME;
}

function targetsOf(input) {
  const tool = input.tool_name;
  const ti = input.tool_input ?? {};
  if (FILE_TOOLS.has(tool)) return [ti.file_path ?? ti.notebook_path].filter(Boolean);
  if (SHELL_TOOLS.has(tool)) return shellWriteTargets(ti.command);
  return [];
}

function wasRead({ input, docRel, root }) {
  const sessionId = input.session_id ?? null;
  const agentId = input.agent_id ?? null;
  const state = readText(path.join(root, STATE_PATH));
  if (state && stateShowsRead(state, sessionId, agentId, docRel)) return true;
  const transcript = agentTranscriptPath(input.transcript_path, agentId);
  const text = transcript ? readText(transcript) : null;
  return Boolean(text && transcriptShowsRead(text, docRel, root, agentId));
}

/**
 * Decision for one PreToolUse input.
 * @returns {{ action: 'allow' | 'deny', message?: string }}
 */
export function decide(input, root = REPO_ROOT) {
  const cwd = input.cwd || root;
  const rels = targetsOf(input)
    .map((t) => repoRelative(t, root, cwd))
    .filter((rel) => !isExempt(rel));
  if (rels.length === 0) return { action: 'allow' };

  const denials = [];
  if (!existsSync(path.join(root, ARCH_README))) {
    // Fail closed: the entry point to the standards is part of the gate's contract.
    denials.push(`${ARCH_README} is missing; restore it before editing code.`);
  } else if (!wasRead({ input, docRel: ARCH_README, root })) {
    denials.push(
      `Read ${ARCH_README} first (Read tool, once per session) and follow the standards it points to.`,
    );
  }

  let registry;
  try {
    registry = validateRegistry(JSON.parse(readFileSync(path.join(root, REGISTRY_PATH), 'utf8')));
  } catch (error) {
    // Fail closed: without a usable registry nobody can tell which PART.md these edits need.
    return {
      action: 'deny',
      message:
        `Part-doc gate: ${REGISTRY_PATH} is missing or malformed (${error.message}). ` +
        'Fix it with `node scripts/arch/part-docs-check.mjs --write-registry` before editing code.',
    };
  }

  for (const rel of rels) {
    const part = findPart(registry, rel);
    // No part, or a part without a PART.md: the general standards are enough (PART-DOCS §3.3).
    if (!part || !existsSync(path.join(root, part.doc))) continue;
    if (!wasRead({ input, docRel: part.doc, root })) {
      denials.push(
        `${rel} belongs to part ${part.id}. Read ${part.doc} first (Read tool) and quote its rule IDs in your plan.`,
      );
    }
  }
  if (denials.length) {
    return {
      action: 'deny',
      message: `Part-doc gate (PART-DOCS §3.3): ${[...new Set(denials)].join(' ')}`,
    };
  }
  return { action: 'allow' };
}

/** PostToolUse(Read): append a record when the README or a PART.md in the repository was read. */
export function record(input, root = REPO_ROOT) {
  if (input.tool_name !== 'Read') return false;
  const rel = repoRelative(input.tool_input?.file_path, root, input.cwd || root);
  if (!rel || !isTrackedDoc(rel)) return false;
  const file = path.join(root, STATE_PATH);
  mkdirSync(path.dirname(file), { recursive: true });
  const line = {
    session_id: input.session_id ?? null,
    agent_id: input.agent_id ?? null,
    doc: rel,
    at: new Date().toISOString(),
  };
  appendFileSync(file, `${JSON.stringify(line)}\n`);
  return true;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const mode = process.argv[2];
  let input;
  try {
    input = JSON.parse(await readStdin());
  } catch {
    process.stderr.write('Part-doc gate: hook input is not JSON.\n');
    process.exit(2);
  }
  if (mode === 'record') {
    record(input);
    return;
  }
  if (mode !== 'gate') {
    process.stderr.write('usage: part-docs-gate.mjs gate|record  (hook JSON on stdin)\n');
    process.exit(2);
  }
  const result = decide(input);
  if (result.action === 'deny') {
    process.stderr.write(`${result.message}\n`);
    process.exit(2);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();

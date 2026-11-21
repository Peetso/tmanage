import type { AiToolDefinition } from '../ai-client.js';
import { AI_TIERS, AI_TIER_SPECS, type AiTier } from '../ai-tiers.js';
import { recordHref } from './knowledge.js';

/**
 * 62-25 (plan 62 §4.2, §4.5, §9 row 62-25) — questions about one file, backend only.
 *
 * The member asks about a file they can open ("what is the notice period in this contract?").
 * Before any task opens, the chat reads the file through the member's own route
 * (`knowledge.files.get`, the file's read rule) and decides the tier from what it holds, never
 * from the model:
 *
 * - **A summary of these bytes is saved** (for the file's audience): Low, with the summary and the
 *   passages that answer the question. This is the second, cheap question.
 * - **Text, no summary yet**: by its size — Low up to {@link LOW_TEXT_MAX_CHARS}, Medium up to
 *   {@link MEDIUM_TEXT_MAX_CHARS}, else Medium-High, which asks first (the estimate stop; plan 62
 *   J4). The model also records a neutral summary ({@link RECORD_FILE_SUMMARY_TOOL}) so the next
 *   question is Low.
 * - **A scan** (a PDF with no text layer): never read silently. The turn stops at an estimate that
 *   offers "read the scan with AI" ({@link SCAN_TIER}, Sonnet, asks first); only a turn that sends
 *   that offer back accepted reads the PDF's pages (at most {@link SCAN_MAX_PAGES}).
 * - **No text yet or not readable**: Low, and the model says so plainly.
 *
 * Every size here is provisional until the Phase 0 benchmark and Gate B fix it (plan 62 §6), like
 * the tiers themselves (`ai-tiers.ts`).
 */

export const FILE_READ_OP = 'knowledge.files.get';
export const RECORD_FILE_SUMMARY_TOOL = 'record_file_summary';

/** About 5,000 tokens: one Low call holds it with room for the answer. */
export const LOW_TEXT_MAX_CHARS = 20_000;
/** About 15,000 tokens: a Medium call. Longer text asks first. */
export const MEDIUM_TEXT_MAX_CHARS = 60_000;
/** The tier a scan is read at: Sonnet, asks first. */
export const SCAN_TIER: AiTier = 'medium_high';
/** The most pages a scan read sends (provisional; fits one Sonnet call's context). */
export const SCAN_MAX_PAGES = 30;

export type FileStatus = 'ready' | 'scan_only' | 'pending' | 'unsupported';

/** The file as the chat read it (the `knowledge.files.get` view, parsed at the boundary). */
export interface FileRead {
  readonly fileId: string;
  readonly fileName: string;
  readonly href: string;
  readonly audience: 'internal' | 'client_visible' | 'client_action_required';
  readonly status: FileStatus;
  readonly reasonCode: string | null;
  readonly chars: number;
  readonly pages: number | null;
  readonly truncated: boolean;
  readonly textId: string | null;
  readonly summary: string | null;
  readonly text: string | null;
  readonly textCut: boolean;
  readonly passages: readonly {
    readonly pageNo: number | null;
    readonly text: string;
  }[];
}

const STATUSES: readonly FileStatus[] = ['ready', 'scan_only', 'pending', 'unsupported'];
const AUDIENCES = ['internal', 'client_visible', 'client_action_required'] as const;

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);

function unwrap(data: unknown, depth = 0): Record<string, unknown> | null {
  if (typeof data === 'string') {
    try {
      return unwrap(JSON.parse(data), depth);
    } catch {
      return null;
    }
  }
  if (typeof data !== 'object' || data === null || depth > 3) return null;
  const record = data as Record<string, unknown>;
  if (typeof record['fileId'] === 'string' && typeof record['status'] === 'string') return record;
  for (const key of ['data', 'body', 'result']) {
    const inner = unwrap(record[key], depth + 1);
    if (inner !== null) return inner;
  }
  return null;
}

/** The route's view, or `null` when the result is not one (an error, another shape). */
export function fileReadOf(data: unknown): FileRead | null {
  const record = unwrap(data);
  if (record === null) return null;
  const status = record['status'];
  if (!STATUSES.includes(status as FileStatus)) return null;
  const audience = AUDIENCES.find((value) => value === record['audience']) ?? null;
  if (audience === null) return null;
  const passages = Array.isArray(record['passages']) ? record['passages'] : [];
  return {
    fileId: String(record['fileId']),
    fileName: str(record['fileName']) ?? '',
    href: recordHref('file', String(record['fileId'])) ?? '',
    audience,
    status: status as FileStatus,
    reasonCode: str(record['reasonCode']),
    chars: typeof record['chars'] === 'number' ? record['chars'] : 0,
    pages: typeof record['pages'] === 'number' ? record['pages'] : null,
    truncated: record['truncated'] === true,
    textId: str(record['textId']),
    summary: str(record['summary']),
    text: str(record['text']),
    textCut: record['textCut'] === true,
    passages: passages.flatMap((raw) => {
      if (typeof raw !== 'object' || raw === null) return [];
      const hit = raw as Record<string, unknown>;
      const text = str(hit['text']);
      if (text === null) return [];
      return [{ pageNo: typeof hit['pageNo'] === 'number' ? hit['pageNo'] : null, text }];
    }),
  };
}

const rank = (tier: AiTier) => AI_TIERS.indexOf(tier);

/** What the member accepted on an earlier estimate of this file question. */
export interface FileAccepted {
  readonly tier: AiTier;
  readonly scan: boolean;
}

export type FilePlan =
  /** Answer now at this tier: from the summary, the text, or (no text) the file's state. */
  | { readonly kind: 'answer'; readonly tier: AiTier; readonly mode: 'summary' | 'text' | 'none' }
  /** Read the scan's pages at {@link SCAN_TIER} (the member accepted it). */
  | { readonly kind: 'scan'; readonly tier: AiTier }
  /** Stop: the member sees the estimate first (`scan` = it offers reading the scan with AI). */
  | { readonly kind: 'estimate'; readonly tier: AiTier; readonly scan: boolean };

/** The tier the text of a file needs (Low, Medium, Medium-High), by its length. */
export function textTierOf(chars: number): AiTier {
  if (chars <= LOW_TEXT_MAX_CHARS) return 'low';
  if (chars <= MEDIUM_TEXT_MAX_CHARS) return 'medium';
  return 'medium_high';
}

/**
 * Pure: the plan of a file question. A tier that asks first runs only when the member accepted
 * that tier (or a higher one) for this question; a scan is read only when they accepted the scan.
 */
export function planFileQuestion(file: FileRead, accepted: FileAccepted | null): FilePlan {
  if (file.summary !== null) return { kind: 'answer', tier: 'low', mode: 'summary' };
  if (file.status === 'scan_only') {
    if (accepted?.scan === true && rank(accepted.tier) >= rank(SCAN_TIER)) {
      return { kind: 'scan', tier: SCAN_TIER };
    }
    return { kind: 'estimate', tier: SCAN_TIER, scan: true };
  }
  if (file.status !== 'ready' || file.text === null) {
    return { kind: 'answer', tier: 'low', mode: 'none' };
  }
  const needed = textTierOf([...file.text].length);
  const takes = accepted !== null && !accepted.scan && rank(accepted.tier) >= rank(needed);
  if (AI_TIER_SPECS[needed].asksFirst && !takes) {
    return { kind: 'estimate', tier: needed, scan: false };
  }
  // An accepted higher tier (after a tier stop) is the member's choice.
  return { kind: 'answer', tier: takes ? accepted.tier : needed, mode: 'text' };
}

const NL = String.fromCodePoint(10);

function stateSentence(file: FileRead): string {
  switch (file.status) {
    case 'pending':
      return 'Its text is not ready yet (the file is still being checked or read). Say so; do not guess what it contains.';
    case 'scan_only':
      return 'It is a scan with no text layer; its text was not read.';
    case 'unsupported':
      return `Its text cannot be read (${file.reasonCode ?? 'unsupported'}). Say so; do not guess what it contains.`;
    default:
      return '';
  }
}

/**
 * The file as the model reads it: one numbered source with its in-app path, then the saved
 * summary and passages, or the text, or why there is none. The caller marks it untrusted.
 */
export function fileContextText(file: FileRead, plan: FilePlan): string {
  const head = [
    '[1] file',
    file.fileName === '' ? '(untitled)' : file.fileName,
    file.href,
    ...(file.pages === null ? [] : [`${String(file.pages)} pages`]),
  ].join(' | ');
  const lines = [head];
  if (plan.kind === 'scan') {
    lines.push('The attached PDF is this file, a scan: read its pages.');
  } else if (plan.kind === 'answer' && plan.mode === 'summary') {
    lines.push('Saved summary:', file.summary ?? '');
    for (const passage of file.passages) {
      lines.push(
        passage.pageNo === null ? 'Passage:' : `Passage (page ${String(passage.pageNo)}):`,
        passage.text,
      );
    }
  } else if (plan.kind === 'answer' && plan.mode === 'text') {
    lines.push('Text:', file.text ?? '');
    if (file.textCut || file.truncated)
      lines.push('(The text was cut here; say so if it matters.)');
  } else {
    lines.push(stateSentence(file));
  }
  return lines.join(NL);
}

/** Strict: one required string. */
export const RECORD_FILE_SUMMARY_TOOL_DEFINITION: AiToolDefinition = Object.freeze({
  name: RECORD_FILE_SUMMARY_TOOL,
  description:
    'Save a neutral summary of the file you were given: what it is, its main points, and the ' +
    'figures, dates, names and terms in it, in at most 300 words. Saved summaries make later ' +
    'questions about the same file cheaper. Call it once, before you answer.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['summary'],
    properties: {
      summary: { type: 'string', description: 'The summary of the whole file.' },
    },
  },
}) as AiToolDefinition;

/** Whether the turn offers {@link RECORD_FILE_SUMMARY_TOOL}: the model reads the whole file. */
export function offersSummary(file: FileRead, plan: FilePlan): boolean {
  return (
    file.textId !== null &&
    file.summary === null &&
    (plan.kind === 'scan' || (plan.kind === 'answer' && plan.mode === 'text'))
  );
}

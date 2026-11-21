import type { Principal } from '@tmanage/domain';
import type { FileAssetRow } from '../../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../../common/database/tenant-context.js';
import { ApiError } from '../../../common/http/errors.js';
import type { FileKnowledgeRepository, FileKnowledgeState } from './file-knowledge.repository.js';
import { mayReadFileAsset } from './knowledge-retrieval.js';
import type { KnowledgeRetrieval } from './knowledge-retrieval.js';
import { filePassageView } from './knowledge.controller.js';
import type { FilePassageView } from './knowledge.controller.js';

/**
 * 62-25 (plan 62 §4.5, §9 row 62-25) — one file as the AI may read it for a member's question:
 * what the text job made of it, the cached summary of its bytes, and either the text itself or
 * the passages of it that answer the question.
 *
 * - **Read rule.** The file's own: live, servable, and the member may open it (`mayReadFileAsset`,
 *   the same check every passage passes). Anything else is 404 with no hint whether it exists.
 * - **Summary first.** When a summary of these bytes exists for the file's audience, the view
 *   carries it and the passages for the question, not the whole text: the second question about
 *   the same file is cheap (the chat routes it to the Low tier).
 * - **Scans are never read here.** A PDF with no text layer is `scan_only`: the view says so and
 *   carries no text. Reading it with the AI is the member's explicit choice in the chat (an
 *   estimate they accept); this route never sends a byte of it anywhere.
 *
 * What comes back is text other people wrote: the chat marks it untrusted (the op id matches the
 * untrusted pattern, 62-12).
 */

/** The most text one view carries (about 37,500 tokens); a longer text is cut and says so. */
export const FILE_TEXT_READ_MAX_CHARS = 150_000;
/** Passages of the file that answer the question, beside a cached summary. */
export const FILE_SUMMARY_PASSAGES = 4;
/** The longest summary the chat may record (about 1,500 tokens). */
export const FILE_SUMMARY_MAX_CHARS = 6_000;

export type FileKnowledgeStatus = 'ready' | 'scan_only' | 'pending' | 'unsupported';

export interface FileKnowledgeView {
  readonly fileId: string;
  readonly fileName: string;
  readonly projectId: string;
  readonly href: string;
  readonly audience: FileAssetRow['audience'];
  readonly status: FileKnowledgeStatus;
  /** Why the text is not there (`pdf_no_text_layer`, `unsupported_too_large`, …). */
  readonly reasonCode: string | null;
  /** Characters of extracted text (0 when there is none). */
  readonly chars: number;
  readonly pages: number | null;
  /** The text job stopped at its own cap (plan 62 §4.5: 20 MB, 200 pages, 1,000,000 chars). */
  readonly truncated: boolean;
  /** The text row the chat records a summary against (never the content hash). */
  readonly textId: string | null;
  readonly summary: string | null;
  /** The text, only when there is no summary yet; at most {@link FILE_TEXT_READ_MAX_CHARS}. */
  readonly text: string | null;
  readonly textCut: boolean;
  readonly passages: readonly FilePassageView[];
}

/** Pure: how a text row reads to the member and the model. */
export function fileKnowledgeStatus(state: FileKnowledgeState): FileKnowledgeStatus {
  const text = state.text;
  if (state.contentHash === null || text === null || text.status === 'pending') return 'pending';
  if (text.status === 'ready') return 'ready';
  if (text.reasonCode === 'pdf_no_text_layer') return 'scan_only';
  return 'unsupported';
}

/** Pure: the view of one readable file (before passages). */
export function fileKnowledgeView(
  state: FileKnowledgeState,
  passages: readonly FilePassageView[] = [],
): FileKnowledgeView {
  const status = fileKnowledgeStatus(state);
  const summary = state.summary?.summary ?? null;
  const body = status === 'ready' && summary === null ? (state.text?.body ?? null) : null;
  const chars = body === null ? [] : [...body];
  return {
    fileId: state.asset.id,
    fileName: state.asset.name,
    projectId: state.asset.projectId,
    href: `/files/${encodeURIComponent(state.asset.id)}`,
    audience: state.asset.audience,
    status,
    reasonCode: status === 'ready' ? null : (state.text?.reasonCode ?? null),
    chars: state.text?.charCount ?? 0,
    pages: state.text?.pageCount ?? null,
    truncated: state.text?.truncated ?? false,
    textId: state.text?.id ?? null,
    summary,
    text: body === null ? null : chars.slice(0, FILE_TEXT_READ_MAX_CHARS).join(''),
    textCut: chars.length > FILE_TEXT_READ_MAX_CHARS,
    passages,
  };
}

export class FileKnowledgeService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly repository: FileKnowledgeRepository,
    private readonly retrieval: Pick<KnowledgeRetrieval, 'passages'>,
  ) {}

  async view(
    context: TenantContext,
    principal: Principal,
    fileAssetId: string,
    question: string | null,
  ): Promise<FileKnowledgeView> {
    const state = await this.database.read(context, (db) =>
      this.repository.read(db, context, fileAssetId),
    );
    if (state === null || !mayReadFileAsset(principal, state.asset)) {
      throw new ApiError(404, 'not_found', 'Not found.', undefined, 'knowledge.file_not_visible');
    }
    const ready = fileKnowledgeStatus(state) === 'ready';
    const passages =
      ready && state.summary !== null && question !== null
        ? await this.retrieval.passages(context, principal, question, {
            projectId: state.asset.projectId,
            fileAssetId: state.asset.id,
            limit: FILE_SUMMARY_PASSAGES,
          })
        : [];
    return fileKnowledgeView(state, passages.map(filePassageView));
  }

  /**
   * Records the summary the model wrote for a text row and audience. The text row and audience
   * come from a view this member read in the same turn, never from the model. `false` when the
   * text row is gone.
   */
  async recordSummary(
    context: TenantContext,
    summary: {
      readonly textId: string;
      readonly audience: FileAssetRow['audience'];
      readonly summary: string;
      readonly model: string;
    },
    now: Date,
  ): Promise<boolean> {
    const text = [...summary.summary.trim()].slice(0, FILE_SUMMARY_MAX_CHARS).join('');
    if (text === '') return false;
    return this.database.transaction(context, (tx) =>
      this.repository.upsertSummary(tx, context, { ...summary, summary: text }, now),
    );
  }
}

import type { Node as PmNode } from '@tiptap/pm/model';

/**
 * **53-11 — doc comments survive edits.** A comment hangs on a `mark[data-comment]` in the body.
 * When an edit removes that mark (the sentence was retyped, pasted over, or split), the thread is
 * not lost: it is re-anchored to the text nearest its saved quote, or shown as "Text removed" when
 * nothing close is left. Pure functions, so the rules are testable without an editor.
 *
 * - `exact` — the mark is still in the body.
 * - `moved` — no mark, but the quote (or most of it) was found; a decoration re-draws the mark.
 * - `lost` — no mark and no close text; the thread stays in the rail.
 */
export type AnchorState = 'exact' | 'moved' | 'lost';

export interface TextRange {
  readonly from: number;
  readonly to: number;
}

export interface CommentAnchor {
  readonly anchorId: string;
  readonly quote: string | null;
}

export interface ReanchorPlan {
  readonly states: Readonly<Record<string, AnchorState>>;
  /** ProseMirror ranges for the `moved` anchors. */
  readonly ranges: readonly (TextRange & { readonly anchorId: string })[];
}

/** The shortest piece of a quote still worth re-anchoring to. */
const MIN_MATCH_LENGTH = 4;

function occurrences(haystack: string, needle: string): number[] {
  const found: number[] = [];
  if (needle === '') return found;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    found.push(at);
  }
  return found;
}

function nearest(starts: readonly number[], hint: number): number | undefined {
  let best: number | undefined;
  for (const start of starts) {
    if (best === undefined || Math.abs(start - hint) < Math.abs(best - hint)) best = start;
  }
  return best;
}

/** Lower-cased text with whitespace runs collapsed to one space, and each char's original index. */
function normalise(text: string): { readonly text: string; readonly index: readonly number[] } {
  let out = '';
  const index: number[] = [];
  let lastSpace = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i] as string;
    if (/\s/u.test(char)) {
      if (lastSpace) continue;
      lastSpace = true;
      out += ' ';
    } else {
      lastSpace = false;
      out += char.toLocaleLowerCase();
    }
    index.push(i);
  }
  return { text: out, index };
}

/**
 * Where a comment's quote is now: the exact text nearest `hint`, else the same words ignoring case
 * and spacing, else the longest run of the quote's words (at least half of them) still present.
 */
export function findNearestQuote(text: string, quote: string, hint = 0): TextRange | null {
  const wanted = quote.trim();
  if (wanted.length < MIN_MATCH_LENGTH) {
    const exact = nearest(occurrences(text, wanted), hint);
    return wanted !== '' && exact !== undefined ? { from: exact, to: exact + wanted.length } : null;
  }
  const exact = nearest(occurrences(text, wanted), hint);
  if (exact !== undefined) return { from: exact, to: exact + wanted.length };

  const hay = normalise(text);
  const words = normalise(wanted).text.trim().split(' ');
  const minWords = Math.max(1, Math.ceil(words.length / 2));
  for (let size = words.length; size >= minWords; size -= 1) {
    const starts: { from: number; to: number }[] = [];
    for (let first = 0; first + size <= words.length; first += 1) {
      const piece = words.slice(first, first + size).join(' ');
      if (piece.length < MIN_MATCH_LENGTH) continue;
      for (const at of occurrences(hay.text, piece)) {
        const from = hay.index[at] as number;
        const to = (hay.index[at + piece.length - 1] as number) + 1;
        starts.push({ from, to });
      }
    }
    const best = nearest(
      starts.map((range) => range.from),
      hint,
    );
    if (best !== undefined) return starts.find((range) => range.from === best) ?? null;
  }
  return null;
}

/**
 * The body's text with a newline between blocks (so a quote never matches across paragraphs),
 * and a map from each character back to its ProseMirror position.
 */
export function textWithPositions(doc: PmNode): {
  readonly text: string;
  readonly positions: readonly number[];
} {
  let text = '';
  const positions: number[] = [];
  doc.descendants((node, pos) => {
    if (node.isBlock && text !== '' && !text.endsWith('\n')) {
      text += '\n';
      positions.push(-1);
    }
    if (node.isText && node.text) {
      for (let i = 0; i < node.text.length; i += 1) positions.push(pos + i);
      text += node.text;
    }
    return true;
  });
  return { text, positions };
}

/** The comment ids that still have a mark in the body. */
export function markedAnchorIds(doc: PmNode, markName = 'comment'): Set<string> {
  const ids = new Set<string>();
  doc.descendants((node) => {
    for (const mark of node.marks) {
      const id = mark.attrs['commentId'];
      if (mark.type.name === markName && typeof id === 'string') ids.add(id);
    }
  });
  return ids;
}

/** Decide each anchor's state and, for the moved ones, the range to re-draw the mark on. */
export function planReanchor(doc: PmNode, anchors: readonly CommentAnchor[]): ReanchorPlan {
  const marked = markedAnchorIds(doc);
  const states: Record<string, AnchorState> = {};
  const ranges: (TextRange & { anchorId: string })[] = [];
  let body: ReturnType<typeof textWithPositions> | null = null;
  for (const anchor of anchors) {
    if (marked.has(anchor.anchorId)) {
      states[anchor.anchorId] = 'exact';
      continue;
    }
    body ??= textWithPositions(doc);
    const found = anchor.quote ? findNearestQuote(body.text, anchor.quote) : null;
    const from = found ? body.positions[found.from] : undefined;
    const last = found ? body.positions[found.to - 1] : undefined;
    if (from === undefined || last === undefined || from < 0 || last < 0) {
      states[anchor.anchorId] = 'lost';
      continue;
    }
    states[anchor.anchorId] = 'moved';
    ranges.push({ anchorId: anchor.anchorId, from, to: last + 1 });
  }
  return { states, ranges };
}

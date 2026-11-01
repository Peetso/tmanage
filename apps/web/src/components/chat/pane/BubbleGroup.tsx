import type { MessageSummary } from '../../../lib/api/conversations';

/** Where a bubble sits in a run of consecutive messages by one author. */
export type BubbleRun = 'single' | 'first' | 'middle' | 'last';

/** Two messages within this gap, by one author, on one day, read as one run. */
const RUN_GAP_MS = 5 * 60 * 1000;

function joins(previous: MessageSummary | undefined, current: MessageSummary): boolean {
  if (previous === undefined) return false;
  if (previous.kind === 'system' || current.kind === 'system') return false;
  if (previous.authorUserId !== current.authorUserId) return false;
  const a = new Date(previous.createdAt);
  const b = new Date(current.createdAt);
  if (a.toDateString() !== b.toDateString()) return false;
  return b.getTime() - a.getTime() <= RUN_GAP_MS;
}

/**
 * R7 slice 4 — group consecutive bubbles: the first of a run shows the author (in a group), the
 * rest tuck under it with a tighter corner. Answers one position per message, in order.
 */
export function bubbleRuns(rows: readonly MessageSummary[]): readonly BubbleRun[] {
  return rows.map((current, index) => {
    const withPrevious = joins(rows[index - 1], current);
    const withNext = index + 1 < rows.length && joins(current, rows[index + 1] as MessageSummary);
    if (withPrevious && withNext) return 'middle';
    if (withPrevious) return 'last';
    if (withNext) return 'first';
    return 'single';
  });
}

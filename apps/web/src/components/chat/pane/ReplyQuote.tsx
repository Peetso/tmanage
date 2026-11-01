'use client';

import { useTOr } from '../../../lib/i18n/use-t-or';
import './pane.css';

/** Scroll the transcript to a message and focus it, when it is loaded. */
export function jumpToMessage(messageId: string): void {
  const row = document.getElementById(`message-${messageId}`);
  if (row === null) return;
  row.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
  row.setAttribute('tabindex', '-1');
  row.focus({ preventScroll: true });
}

/**
 * R7 slice 4 — the quoted message above a reply (and in the composer while replying). A click
 * scrolls to the source when it is in the loaded transcript.
 */
export function ReplyQuote({
  authorName,
  excerpt,
  sourceId,
}: {
  authorName: string;
  excerpt: string;
  sourceId?: string;
}) {
  const tOr = useTOr();
  const content = (
    <>
      <span className="tm-pane-quote__author">{authorName}</span>
      <span className="tm-pane-quote__excerpt">{excerpt}</span>
    </>
  );
  if (sourceId === undefined) return <span className="tm-pane-quote">{content}</span>;
  return (
    <button
      type="button"
      className="tm-pane-quote"
      aria-label={`${tOr('ChatMessages.jumpToQuoted', 'Go to the quoted message')}: ${authorName}`}
      onClick={() => jumpToMessage(sourceId)}
    >
      {content}
    </button>
  );
}

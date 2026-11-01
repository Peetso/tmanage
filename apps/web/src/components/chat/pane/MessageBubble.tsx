'use client';

import type { ReactNode } from 'react';
import type { MessageSummary } from '../../../lib/api/conversations';
import { isForwarded, replyMetaOf } from '../../../lib/api/conversations';
import { useTOr } from '../../../lib/i18n/use-t-or';
import type { BubbleRun } from './BubbleGroup';
import { LocationBubble } from './LocationBubble';
import { ReplyQuote } from './ReplyQuote';
import './pane.css';

export interface MessageBubbleProps {
  message: MessageSummary;
  /** The reader wrote it: drawn at the inline end, dark. */
  own: boolean;
  run?: BubbleRun;
  /** The author's name, shown on the first bubble of a run in a group. */
  authorName?: string;
  showAuthor?: boolean;
  /** Resolves the quoted author's name. */
  nameOf: (userId: string) => string;
  /** The text body as the screen renders it (mentions, rich text) — or the inline edit card. */
  body?: ReactNode;
  /** Attachment cards, link preview — under the body. */
  attachments?: ReactNode;
  /** The delivery ticks (slice 6), in the footer of an own bubble. */
  ticks?: ReactNode;
  /** The screen draws author, time and "edited" in its own head row. */
  headless?: boolean;
  /** A voice note's player (slice 5). */
  voice?: ReactNode;
  /** A system line (slice 3) — drawn instead of a bubble. */
  system?: ReactNode;
}

function locationOf(meta: MessageSummary['meta']) {
  if (meta == null) return undefined;
  const { lat, lng, label } = meta;
  if (typeof lat !== 'number' || typeof lng !== 'number') return undefined;
  return { lat, lng, label: typeof label === 'string' ? label : '' };
}

/**
 * R7 slice 4 — one message as a bubble: own at the inline end, others at the start with the
 * author on the first of a run; the reply quote, the "Forwarded" label, the body by kind
 * (text / location / voice), files, the "edited" marker and the tombstone for a deleted message.
 * A message deleted by its author reads "This message was deleted"; one a moderator removed
 * keeps its moderation wording.
 */
export function MessageBubble({
  message,
  own,
  run = 'single',
  authorName,
  showAuthor = false,
  nameOf,
  body,
  attachments,
  ticks,
  headless = false,
  voice,
  system,
}: MessageBubbleProps) {
  const tOr = useTOr();
  if (message.kind === 'system') {
    return <>{system ?? <p className="tm-pane-bubble__meta">{message.body ?? ''}</p>}</>;
  }

  const deleted = message.deletedAt !== null;
  const byAuthor = deleted && message.deletedByUserId === message.authorUserId;
  const reply = deleted ? undefined : replyMetaOf(message);
  const location = message.kind === 'location' ? locationOf(message.meta) : undefined;

  let content: ReactNode;
  if (deleted && byAuthor) {
    content = (
      <p className="tm-pane-tombstone">{tOr('ChatMessages.deleted', 'This message was deleted')}</p>
    );
  } else if (deleted) {
    content = body;
  } else if (location !== undefined) {
    content = <LocationBubble {...location} />;
  } else if (message.kind === 'voice') {
    content = voice ?? body;
  } else {
    content = body;
  }

  return (
    <div
      className="tm-pane-bubble"
      data-own={own ? 'true' : 'false'}
      data-run={run}
      data-kind={message.kind}
    >
      {showAuthor && !own && !headless && authorName !== undefined ? (
        <span className="tm-chat-message__author">{authorName}</span>
      ) : null}
      {!deleted && isForwarded(message) ? (
        <span className="tm-pane-bubble__forwarded">
          <span aria-hidden="true">↪ </span>
          {tOr('ChatMessages.forwarded', 'Forwarded')}
        </span>
      ) : null}
      {reply !== undefined ? (
        <ReplyQuote
          authorName={nameOf(reply.authorUserId)}
          excerpt={reply.excerpt}
          sourceId={reply.replyToMessageId}
        />
      ) : null}
      {content}
      {deleted ? null : attachments}
      {headless ? null : (
        <span className="tm-pane-bubble__foot">
          {message.editedAt !== null && !deleted ? (
            <span className="tm-pane-bubble__edited">{tOr('ChatMessages.edited', 'edited')}</span>
          ) : null}
          <time className="tm-pane-bubble__meta" dateTime={message.createdAt}>
            {new Date(message.createdAt).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
            })}
          </time>
          {own ? ticks : null}
        </span>
      )}
      {headless && own ? ticks : null}
    </div>
  );
}

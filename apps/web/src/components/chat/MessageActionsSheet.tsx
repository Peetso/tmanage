'use client';

import { useEffect, useRef } from 'react';
import { useTOr } from '../../lib/i18n/use-t-or';
import { useT } from '../../lib/i18n/use-t';
import { QUICK_REACTIONS, reactionLabel } from '../screens/MessageReactionsView';
import './chat-shell.css';

export interface MessageActionsSheetProps {
  /** Which of the quick reactions the member already holds — drawn pressed. */
  reacted: ReadonlySet<string>;
  onReact: (emoji: string) => void;
  /** The "+" chip: the full reaction picker under the message. */
  onMoreReactions: () => void;
  onReply: () => void;
  /** F3. Absent when the message has no text to record (a rich or removed message). */
  onRecordDecision?: () => void;
  /** Absent when the message cannot be edited here (a rich or removed message). */
  onEdit?: () => void;
  /** Absent when the message has no text to copy. */
  onCopy?: () => void;
  /** The first attachment's download address; absent when the message carries none. */
  attachmentHref?: string;
  attachmentName?: string;
  /** Absent for a removed message. */
  onDelete?: () => void;
  onClose: () => void;
}

/**
 * **A16 — phone message actions sheet** (Figma 386:4027 / 386:4167). Opened by a long press on a
 * message, or by its keyboard-reachable "More actions" control: a bottom sheet with the quick
 * reactions row (♥ ✓ ☺ ★ +) over Reply in thread · Edit message · Copy text · Save attachment ·
 * Delete message. Every action that does not apply to the message is left out rather than drawn
 * disabled. Delete hands back to the channel's own remove confirmation, so moderation still asks
 * before it withholds a body.
 *
 * A modal dialog: focus moves to the first reaction on open, Escape and the scrim close it, and
 * the channel restores focus to the message's control on close.
 */
export function MessageActionsSheet({
  reacted,
  onReact,
  onMoreReactions,
  onReply,
  onRecordDecision,
  onEdit,
  onCopy,
  attachmentHref,
  attachmentName,
  onDelete,
  onClose,
}: MessageActionsSheetProps) {
  const t = useT();
  const tOr = useTOr();
  const firstRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    firstRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const act = (run: () => void) => () => {
    run();
    onClose();
  };

  return (
    <div className="tm-chat-sheet-scrim">
      {/* The scrim closes the sheet on a tap; keyboard users close it with Escape. */}
      <button
        type="button"
        className="tm-chat-sheet-scrim__close"
        tabIndex={-1}
        aria-hidden="true"
        onClick={onClose}
      />
      <div
        className="tm-chat-actions-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={tOr('MessageActionsSheet.title', 'Message actions')}
      >
        <span className="tm-chat-actions-sheet__handle" aria-hidden="true" />
        <div
          className="tm-chat-actions-sheet__reacts"
          role="group"
          aria-label={t('MessageReactionsView.reactionsGroup')}
        >
          {QUICK_REACTIONS.map((emoji, index) => (
            <button
              key={emoji}
              ref={index === 0 ? firstRef : undefined}
              type="button"
              className="tm-chat-actions-sheet__react"
              aria-pressed={reacted.has(emoji)}
              aria-label={reactionLabel(emoji, tOr, t)}
              onClick={act(() => onReact(emoji))}
            >
              <span aria-hidden="true">{emoji === '❤️' ? '♥' : emoji}</span>
            </button>
          ))}
          <button
            type="button"
            className="tm-chat-actions-sheet__react tm-chat-actions-sheet__react--more"
            aria-label={tOr('ProjectChannelScreen.addReaction', 'Add a reaction')}
            onClick={act(onMoreReactions)}
          >
            <span aria-hidden="true">+</span>
          </button>
        </div>
        <ul className="tm-chat-actions-sheet__list">
          <li>
            <button type="button" className="tm-chat-actions-sheet__item" onClick={act(onReply)}>
              <span className="tm-chat-actions-sheet__glyph" aria-hidden="true">
                ↩
              </span>
              {t('ProjectChannelScreen.replyInThread')}
            </button>
          </li>
          {onRecordDecision ? (
            <li>
              <button
                type="button"
                className="tm-chat-actions-sheet__item"
                aria-haspopup="dialog"
                onClick={act(onRecordDecision)}
              >
                <span className="tm-chat-actions-sheet__glyph" aria-hidden="true">
                  ◇
                </span>
                {tOr('RecordDecision.action', 'Record as decision')}
              </button>
            </li>
          ) : null}
          {onEdit ? (
            <li>
              <button type="button" className="tm-chat-actions-sheet__item" onClick={act(onEdit)}>
                <span className="tm-chat-actions-sheet__glyph" aria-hidden="true">
                  ✎
                </span>
                {tOr('MessageActionsSheet.edit', 'Edit message')}
              </button>
            </li>
          ) : null}
          {onCopy ? (
            <li>
              <button type="button" className="tm-chat-actions-sheet__item" onClick={act(onCopy)}>
                <span className="tm-chat-actions-sheet__glyph" aria-hidden="true">
                  ⧉
                </span>
                {tOr('MessageActionsSheet.copy', 'Copy text')}
              </button>
            </li>
          ) : null}
          {attachmentHref ? (
            <li>
              <a
                className="tm-chat-actions-sheet__item"
                href={attachmentHref}
                download={attachmentName ?? true}
                onClick={onClose}
              >
                <span className="tm-chat-actions-sheet__glyph" aria-hidden="true">
                  ⤓
                </span>
                {tOr('MessageActionsSheet.saveAttachment', 'Save attachment')}
              </a>
            </li>
          ) : null}
          {onDelete ? (
            <li>
              <button type="button" className="tm-chat-actions-sheet__item" onClick={act(onDelete)}>
                <span className="tm-chat-actions-sheet__glyph" aria-hidden="true">
                  ⌫
                </span>
                {tOr('MessageActionsSheet.delete', 'Delete message')}
              </button>
            </li>
          ) : null}
        </ul>
      </div>
    </div>
  );
}

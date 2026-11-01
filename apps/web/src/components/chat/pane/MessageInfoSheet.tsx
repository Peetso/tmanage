'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { Button } from '@tmanage/ui';
import type { MessageSummary } from '../../../lib/api/conversations';
import { appLocale } from '../../../lib/i18n/app-locale';
import { useTOr } from '../../../lib/i18n/use-t-or';
import './pane.css';

function when(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat(appLocale(), { dateStyle: 'medium', timeStyle: 'short' }).format(
    parsed,
  );
}

/**
 * R7 slice 4 — "Message info": when the message was sent and edited, and — through `receipts` —
 * who it was delivered to and who read it (slice 6's `MessageInfoReceipts`).
 */
export function MessageInfoSheet({
  message,
  receipts,
  onClose,
}: {
  message: MessageSummary;
  /** Slice 6's Delivered / Read lists, rendered under the times. */
  receipts?: ReactNode;
  onClose: () => void;
}) {
  const tOr = useTOr();
  const titleRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    titleRef.current?.focus();
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="tm-pane-sheet">
      <div
        className="tm-pane-sheet__card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="tm-message-info-title"
      >
        <h2
          id="tm-message-info-title"
          className="tm-pane-sheet__title"
          tabIndex={-1}
          ref={titleRef}
        >
          {tOr('ChatMessages.infoTitle', 'Message info')}
        </h2>
        <dl className="tm-pane-sheet__list">
          <dt>{tOr('ChatMessages.infoSent', 'Sent')}</dt>
          <dd>
            <time dateTime={message.createdAt}>{when(message.createdAt)}</time>
          </dd>
          {message.editedAt !== null ? (
            <>
              <dt>{tOr('ChatMessages.infoEdited', 'Edited')}</dt>
              <dd>
                <time dateTime={message.editedAt}>{when(message.editedAt)}</time>
              </dd>
            </>
          ) : null}
        </dl>
        {receipts}
        <div className="tm-pane-sheet__actions">
          <Button tone="outline" onClick={onClose}>
            {tOr('ChatMessages.close', 'Close')}
          </Button>
        </div>
      </div>
    </div>
  );
}

'use client';

import type { ReactElement } from 'react';
import type { MessageReceipts } from '../../../lib/api/receipts';
import { useT } from '../../../lib/i18n/use-t';
import './status.css';

export type TickState = 'pending' | 'sent' | 'delivered' | 'read';

/** The fields of a message the ticks read; any message view with these fits. */
export interface TickMessage {
  readonly id?: string | null;
  /** Set while the message exists only on this device (optimistic send). */
  readonly pending?: boolean;
}

/**
 * Pure: the tick state of the viewer's own message. Read only when everyone it reached has read
 * it (a group's ticks turn brand-coloured when the last member reads), delivered when it reached
 * at least one person, sent otherwise.
 */
export function tickState(message: TickMessage, receipts?: MessageReceipts): TickState {
  if (message.pending || !message.id) return 'pending';
  if (!receipts || receipts.deliveredTo.length === 0) return 'sent';
  if (receipts.readBy.length > 0 && receipts.readBy.length >= receipts.deliveredTo.length) {
    return 'read';
  }
  return 'delivered';
}

const LABEL = {
  pending: 'ChatStatus.pending',
  sent: 'ChatStatus.sent',
  delivered: 'ChatStatus.delivered',
  read: 'ChatStatus.read',
} as const;

/** Clock / one grey tick / two grey ticks / two brand ticks — only on the viewer's own messages. */
export function MessageTicks({
  message,
  receipts,
  viewerIsAuthor,
}: {
  readonly message: TickMessage;
  readonly receipts?: MessageReceipts;
  readonly viewerIsAuthor: boolean;
}): ReactElement | null {
  const t = useT();
  if (!viewerIsAuthor) return null;
  const state = tickState(message, receipts);
  return (
    <span className="tm-ticks" data-state={state} role="img" aria-label={t(LABEL[state])}>
      {state === 'pending' ? (
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M8 4.5V8l2.5 1.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      ) : (
        <svg viewBox="0 0 20 16" width="18" height="14" aria-hidden="true">
          <path d="M1.5 8.5l3.5 3.5 7-8" fill="none" stroke="currentColor" strokeWidth="1.6" />
          {state === 'sent' ? null : (
            <path d="M7.5 8.5l3.5 3.5 7-8" fill="none" stroke="currentColor" strokeWidth="1.6" />
          )}
        </svg>
      )}
    </span>
  );
}

import type { ReactElement } from 'react';
import type { ConversationUnreadView } from '../../lib/api/conversation-read-state';

/**
 * The unread badge a channel row wears (module CHAT, CH-05 "unread position", x250).
 *
 * Presentational and self-scoped: it draws the count the API computed for the *viewer's* own read
 * position ({@link ConversationUnreadView.unreadCount}), and nothing when that count is zero — an
 * empty badge is visual noise, and "nothing unread" is the common state. A count past `max` is shown
 * as `max+` so a busy channel does not stretch the row. The screen marks a channel read on open
 * (`markConversationRead`), which is what drives the count back to zero.
 */

export interface ConversationUnreadBadgeProps {
  /** The viewer's unread count for one conversation. */
  readonly unread: Pick<ConversationUnreadView, 'unreadCount'>;
  /** The largest number shown before switching to `max+`. */
  readonly max?: number;
}

export function ConversationUnreadBadge({
  unread,
  max = 99,
}: ConversationUnreadBadgeProps): ReactElement | null {
  const count = unread.unreadCount;
  if (!Number.isFinite(count) || count <= 0) return null;

  const label = count > max ? `${max}+` : String(count);
  return (
    <span
      role="status"
      aria-label={`${count} unread ${count === 1 ? 'message' : 'messages'}`}
      data-unread-badge=""
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        minWidth: '1.25rem',
        height: '1.25rem',
        padding: '0 0.375rem',
        borderRadius: '0.625rem',
        fontSize: '0.6875rem',
        fontWeight: 600,
        lineHeight: 1,
        color: 'var(--color-on-accent, #fff)',
        background: 'var(--color-accent, #2563eb)',
      }}
    >
      {label}
    </span>
  );
}

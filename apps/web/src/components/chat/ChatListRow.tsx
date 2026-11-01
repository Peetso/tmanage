'use client';

import { useId } from 'react';
import Link from 'next/link';
import type { ChatListRowData } from '../../lib/api/chat';
import { useDisplayFormatters } from '../../lib/i18n/use-formatters';
import { useTOr } from '../../lib/i18n/use-t-or';
import { initialsOf } from './channel-browser';

export interface ChatListRowProps {
  readonly row: ChatListRowData;
  readonly href: string;
  readonly active?: boolean;
  /** "Now" for the time column; injected so a test is not at the clock's mercy. */
  readonly now?: Date;
  readonly onTogglePin?: (row: ChatListRowData) => void;
  readonly onToggleArchive?: (row: ChatListRowData) => void;
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * One chat in the list (R7 F1): avatar, title, time of the last message, its excerpt, and the
 * unread badge, pin and mute marks. The title and excerpt sit in `<bdi>` so an Arabic name in an
 * English list (or the reverse) keeps its own direction; the layout itself is logical
 * (inline-start / inline-end), so the whole row mirrors under `dir="rtl"`.
 */
export function ChatListRow({
  row,
  href,
  active = false,
  now,
  onTogglePin,
  onToggleArchive,
}: ChatListRowProps) {
  const tOr = useTOr();
  const format = useDisplayFormatters();
  // Named by the title alone; the time, excerpt, marks and unread count describe it.
  const titleId = useId();
  const detailId = useId();
  const last = row.lastMessage;
  const at = last === null ? null : new Date(last.at);
  const time =
    at === null
      ? ''
      : sameDay(at, now ?? new Date())
        ? format.dateTime(last?.at ?? '', { hour: '2-digit', minute: '2-digit' })
        : format.day(last?.at ?? '', { day: 'numeric', month: 'short' });
  const title =
    row.title !== ''
      ? row.kind === 'project_channel'
        ? `#${row.title}`
        : row.title
      : tOr('ChatList.unknownPerson', 'Someone');
  const excerpt =
    last === null
      ? tOr('ChatList.noMessagesYet', 'No messages yet')
      : last.kind === 'deleted'
        ? tOr('ChatList.messageDeleted', 'This message was deleted')
        : last.kind === 'voice'
          ? tOr('ChatList.voiceNote', 'Voice message')
          : last.kind === 'location'
            ? tOr('ChatList.location', 'Location')
            : (last.excerpt ?? '');
  const author =
    last === null || last.kind === 'deleted' || row.kind === 'direct'
      ? null
      : (last.authorName ?? tOr('ChatList.you', 'You'));
  const unread = active ? 0 : row.unreadCount;
  const avatarClass =
    row.kind === 'direct'
      ? 'tm-chatrow__avatar tm-chatrow__avatar--person'
      : row.kind === 'group'
        ? 'tm-chatrow__avatar tm-chatrow__avatar--group'
        : 'tm-chatrow__avatar tm-chatrow__avatar--channel';

  return (
    <li className={`tm-chatrow${unread > 0 ? ' tm-chatrow--unread' : ''}`}>
      <Link
        className="tm-chatrow__link"
        href={href}
        aria-labelledby={titleId}
        aria-describedby={detailId}
        {...(active ? { 'aria-current': 'page' as const } : {})}
      >
        <span className={avatarClass} aria-hidden="true">
          {row.kind === 'project_channel' ? '#' : initialsOf(row.title || '?')}
        </span>
        <span className="tm-chatrow__main">
          <span className="tm-chatrow__top">
            <bdi id={titleId} className="tm-chatrow__title">
              {title}
            </bdi>
            <span className="tm-chatrow__time">{time}</span>
          </span>
          <span id={detailId} className="tm-chatrow__bottom">
            <span className="tm-chatrow__excerpt">
              {author !== null ? <span className="tm-chatrow__author">{author}: </span> : null}
              <bdi>{excerpt}</bdi>
            </span>
            {row.muted ? (
              <span className="tm-chatrow__mark" title={tOr('ChatList.muted', 'Muted')}>
                <span aria-hidden="true">🔕</span>
                <span className="tm-visually-hidden">{tOr('ChatList.muted', 'Muted')}</span>
              </span>
            ) : null}
            {row.pinnedAt !== null ? (
              <span className="tm-chatrow__mark" title={tOr('ChatList.pinned', 'Pinned')}>
                <span aria-hidden="true">📌</span>
                <span className="tm-visually-hidden">{tOr('ChatList.pinned', 'Pinned')}</span>
              </span>
            ) : null}
            {unread > 0 ? (
              <span className={`tm-chatrow__badge${row.muted ? ' tm-chatrow__badge--muted' : ''}`}>
                <span aria-hidden="true">{unread > 99 ? '99+' : unread}</span>
                <span className="tm-visually-hidden">
                  {`, ${unread} ${
                    unread === 1
                      ? tOr('ChatList.unreadOne', 'unread message')
                      : tOr('ChatList.unreadMany', 'unread messages')
                  }`}
                </span>
              </span>
            ) : null}
          </span>
        </span>
      </Link>
      {onTogglePin || onToggleArchive ? (
        <span className="tm-chatrow__actions">
          {onTogglePin ? (
            <button
              type="button"
              className="tm-chatrow__action"
              onClick={() => onTogglePin(row)}
              aria-label={
                row.pinnedAt !== null
                  ? tOr('ChatList.unpin', 'Unpin chat')
                  : tOr('ChatList.pin', 'Pin chat')
              }
            >
              <span aria-hidden="true">📌</span>
            </button>
          ) : null}
          {onToggleArchive ? (
            <button
              type="button"
              className="tm-chatrow__action"
              onClick={() => onToggleArchive(row)}
              aria-label={
                row.archivedAt !== null
                  ? tOr('ChatList.unarchive', 'Unarchive chat')
                  : tOr('ChatList.archive', 'Archive chat')
              }
            >
              <span aria-hidden="true">🗄</span>
            </button>
          ) : null}
        </span>
      ) : null}
    </li>
  );
}

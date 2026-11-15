'use client';

import type { ReactNode } from 'react';
import { Avatar, Badge, StateCapsule } from '@tmanage/ui';
import type { ReviewComment, ReviewPerson, ReviewThread } from '../../lib/api/review';
import { useDisplayFormatters } from '../../lib/i18n/use-formatters';
import { useT } from '../../lib/i18n/use-t';
import { useReviewDoor } from './review-door';

/** A person's name, or the "former member" word when they have left. */
export function personName(person: ReviewPerson, formerMember: string): string {
  return person.displayName ?? formerMember;
}

const UUID_TOKEN = /@([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/giu;

/**
 * The text of a comment as shown: an old-style `@<userId>` token reads as "@someone" — the viewer
 * has no name for an id the thread does not otherwise mention, and an id is never shown.
 */
export function readableBody(body: string, someone: string): string {
  return body.replace(UUID_TOKEN, `@${someone}`);
}

/** "Page 3 · pin · 2 replies" — where the comment sits and how long the thread is. */
export function useThreadMeta(): (thread: ReviewThread) => string {
  const t = useT();
  return (thread) => {
    const parts: string[] = [];
    if (thread.pageNo !== null && thread.pageNo > 0) {
      parts.push(t('Viewer.thread.page').replace('{page}', String(thread.pageNo)));
    }
    const anchor =
      thread.anchorKind === 'pin'
        ? t('Viewer.thread.kindPin')
        : thread.anchorKind === 'box'
          ? t('Viewer.thread.kindBox')
          : thread.anchorKind === 'draw'
            ? t('Viewer.thread.kindDraw')
            : thread.anchorKind === 'cell'
              ? cellLabel(thread.anchor, t)
              : t('Viewer.thread.kindGeneral');
    parts.push(anchor);
    const replies = Math.max(0, thread.comments.length - 1);
    parts.push(
      replies === 0
        ? t('Viewer.thread.noReplies')
        : replies === 1
          ? t('Viewer.thread.oneReply')
          : t('Viewer.thread.replies').replace('{count}', String(replies)),
    );
    return parts.join(' · ');
  };
}

/** The short time beside a name: 11:40 today, else 9 Aug. */
export function useShortTime(): (iso: string) => string {
  const format = useDisplayFormatters();
  return (iso) => {
    const at = new Date(iso);
    const now = new Date();
    const sameDay =
      at.getFullYear() === now.getFullYear() &&
      at.getMonth() === now.getMonth() &&
      at.getDate() === now.getDate();
    return sameDay
      ? format.dateTime(iso, { hour: '2-digit', minute: '2-digit' })
      : format.day(iso, { day: 'numeric', month: 'short' });
  };
}

/** The numbered pin glyph on a card (Review/Pin `459:22348`). */
export function CardPin({ thread, selected }: { thread: ReviewThread; selected?: boolean }) {
  const state = selected ? 'selected' : thread.status === 'resolved' ? 'resolved' : 'open';
  return (
    <span className="tm-viewer-card-pin" data-state={state} aria-hidden="true">
      {thread.number}
    </span>
  );
}

export interface ThreadCardProps {
  readonly thread: ReviewThread;
  readonly selected: boolean;
  /** The option's element id inside the panel's listbox. */
  readonly optionId: string;
  readonly active: boolean;
  readonly onOpen: (threadId: string) => void;
  /** R4 slice 13 — a line under the card's meta (the Figma frame it is on, "Frame changed"). */
  readonly extra?: ReactNode;
}

/**
 * One thread in the panel's list (V-13): its pin number, who started it and when, the audience
 * ("Team only" / "Visible to client") or "Resolved", the first comment and "Pin · 2 replies". It is
 * an option of the panel's listbox; opening it shows {@link ThreadDetail}.
 */
export function ThreadCard({ thread, selected, optionId, active, onOpen, extra }: ThreadCardProps) {
  const t = useT();
  const { door } = useReviewDoor();
  const meta = useThreadMeta();
  const shortTime = useShortTime();
  const first: ReviewComment | undefined = thread.comments[0];
  const name = personName(thread.createdBy, t('Viewer.person.former'));

  return (
    // An option of the panel's listbox: the keyboard is handled on the listbox itself
    // (aria-activedescendant, arrows + Enter), so the option needs only the pointer.
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events
    <li
      id={optionId}
      role="option"
      aria-selected={selected}
      data-active={active ? 'true' : undefined}
      data-status={thread.status}
      className="tm-viewer-card"
      onClick={() => onOpen(thread.id)}
    >
      <CardPin thread={thread} selected={selected} />
      <div className="tm-viewer-card__main">
        <div className="tm-viewer-card__head">
          <Avatar
            name={name}
            audience={thread.createdBy.kind === 'client' ? 'client' : 'internal'}
            size="compact"
            decorative
          />
          <span className="tm-viewer-card__name">{name}</span>
          <span className="tm-viewer-card__time">{shortTime(thread.createdAt)}</span>
          <span className="tm-viewer-card__tag">
            {thread.status === 'resolved' ? (
              <StateCapsule state="done">{t('Viewer.thread.resolved')}</StateCapsule>
            ) : door === 'portal' ? null : thread.audience === 'internal' ? (
              <Badge>{t('Viewer.audience.internal')}</Badge>
            ) : (
              <Badge tone="client">{t('Viewer.audience.client')}</Badge>
            )}
          </span>
        </div>
        {first ? (
          <p className="tm-viewer-card__body">
            {readableBody(first.body, t('Viewer.person.someone'))}
          </p>
        ) : null}
        <p className="tm-viewer-card__meta">
          {thread.status === 'resolved' && thread.resolvedBy
            ? t('Viewer.thread.resolvedBy').replace(
                '{name}',
                personName(thread.resolvedBy, t('Viewer.person.former')),
              )
            : meta(thread)}
        </p>
        {extra}
      </div>
    </li>
  );
}

/**
 * FIX6 item 9 (B12): a comment on a spreadsheet cell says which cell ("Cell Rates!C7"), not
 * "Whole file". The anchor is `{ sheet, cell }` as the Excel stage stores it.
 */
function cellLabel(
  anchor: Readonly<Record<string, unknown>> | null,
  t: (key: 'Viewer.thread.kindCell' | 'Viewer.thread.kindGeneral') => string,
): string {
  const sheet = typeof anchor?.['sheet'] === 'string' ? anchor['sheet'] : '';
  const cell = typeof anchor?.['cell'] === 'string' ? anchor['cell'] : '';
  if (cell === '') return t('Viewer.thread.kindGeneral');
  return t('Viewer.thread.kindCell').replace('{cell}', sheet === '' ? cell : `${sheet}!${cell}`);
}

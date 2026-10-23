'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import type { WorkItemState } from '@tmanage/domain';
import type { WorkItemSummary } from '../../lib/api/work-items';
import type { MemberSummary } from '../../lib/api/members';
import { memberDisplayName } from '../../lib/members-presentation';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import { addDays, dayOf, formatShortDay, todayOf, useA6T } from '../work/DueDatePicker';
import { initialsOf } from '../work/OwnerPickerDialog';
import './work-core.css';

export type BoardColumn = 'todo' | 'in_progress' | 'in_review' | 'done';

/** Which column each lifecycle state sits in. Archived work is off the board. */
const COLUMN_OF: Record<WorkItemState, BoardColumn | null> = {
  backlog: 'todo',
  ready: 'todo',
  in_progress: 'in_progress',
  blocked: 'in_progress',
  internal_review: 'in_review',
  done: 'done',
  archived: null,
};

const COLUMNS: readonly { readonly id: BoardColumn; readonly key: string }[] = [
  { id: 'todo', key: 'WorkBoard.todo' },
  { id: 'in_progress', key: 'WorkBoard.inProgress' },
  { id: 'in_review', key: 'WorkBoard.inReview' },
  { id: 'done', key: 'WorkBoard.done' },
];

export type DueFilter = 'any' | 'week' | 'month' | 'overdue';

const DUE_KEYS: Record<DueFilter, string> = {
  any: 'WorkBoard.dueAny',
  week: 'WorkBoard.dueWeek',
  month: 'WorkBoard.dueMonth',
  overdue: 'WorkBoard.dueOverdue',
};

export function columnOf(state: WorkItemState): BoardColumn | null {
  return COLUMN_OF[state] ?? null;
}

/** Whether an item's due day passes the board's Due filter, judged against `today`. */
export function matchesDue(item: WorkItemSummary, filter: DueFilter, today: string): boolean {
  if (filter === 'any') return true;
  const due = dayOf(item.dueAt);
  if (due === '') return false;
  if (filter === 'overdue') return due < today && item.state !== 'done';
  if (filter === 'week') return due >= today && due <= addDays(today, 6);
  return due.slice(0, 7) === today.slice(0, 7);
}

export interface WorkBoardViewProps {
  readonly organizationSlug: string;
  readonly items: readonly WorkItemSummary[];
  readonly members: readonly MemberSummary[];
  readonly membersPending: boolean;
  /** Injected in tests so the Due filter can be exercised on a fixed day. */
  readonly now?: Date;
}

/**
 * **Board view (A6, Figma fq7-board-view).**
 *
 * Four columns from the work states — To do (backlog, ready), In progress (in progress,
 * blocked), In review (internal review) and Done — each with a count pill. A card carries the
 * title, "Due d Mon" (or "Done d Mon"), the owner's orb, and a "Client review" chip when an
 * item in review is one the client can see. Owner and Due filter the cards in place.
 */
export function WorkBoardView({
  organizationSlug,
  items,
  members,
  membersPending,
  now,
}: WorkBoardViewProps) {
  const t = useA6T();
  const locale = useActiveLocale();
  const today = todayOf(now ?? new Date());
  const [owner, setOwner] = useState('');
  const [due, setDue] = useState<DueFilter>('any');

  const owners = useMemo(() => {
    const ids = [
      ...new Set(items.map((item) => item.ownerUserId).filter((id): id is string => id !== null)),
    ];
    return ids
      .map((id) => ({ id, name: memberDisplayName(id, members, membersPending) }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }, [items, members, membersPending]);

  const shown = items.filter(
    (item) => (owner === '' || item.ownerUserId === owner) && matchesDue(item, due, today),
  );

  return (
    <section className="tm-wk-board-frame" aria-label={t('WorkBoard.label')}>
      <div className="tm-wk-board__filters">
        <label className="tm-wk-filter-chip">
          <span className="tm-visually-hidden">{t('WorkBoard.ownerFilter')}</span>
          <select value={owner} onChange={(event) => setOwner(event.target.value)}>
            <option value="">{t('WorkBoard.ownerAnyone')}</option>
            {owners.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {t('WorkBoard.ownerIs', { name: entry.name })}
              </option>
            ))}
          </select>
        </label>
        <label className="tm-wk-filter-chip">
          <span className="tm-visually-hidden">{t('WorkBoard.dueFilter')}</span>
          <select value={due} onChange={(event) => setDue(event.target.value as DueFilter)}>
            {(Object.keys(DUE_KEYS) as DueFilter[]).map((key) => (
              <option key={key} value={key}>
                {t(DUE_KEYS[key])}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="tm-wk-board">
        {COLUMNS.map((column) => {
          const cards = shown.filter((item) => columnOf(item.state) === column.id);
          const headingId = `tm-wk-board-${column.id}`;
          return (
            <section key={column.id} className="tm-wk-board__column" aria-labelledby={headingId}>
              <h2 id={headingId} className="tm-wk-board__heading">
                <span>{t(column.key)}</span>
                <span className="tm-wk-count">{cards.length}</span>
              </h2>
              <ul className="tm-wk-board__cards">
                {cards.map((item) => {
                  const name =
                    item.ownerUserId === null
                      ? ''
                      : memberDisplayName(item.ownerUserId, members, membersPending);
                  const finished = item.state === 'done' && item.completedAt !== null;
                  const day = finished ? dayOf(item.completedAt) : dayOf(item.dueAt);
                  return (
                    <li key={item.id} className="tm-wk-card-tile">
                      <Link
                        className="tm-wk-card-tile__title"
                        href={`/${organizationSlug}/work/${item.id}`}
                      >
                        {item.title}
                      </Link>
                      {item.state === 'internal_review' && item.audience !== 'internal' ? (
                        <span className="tm-wk-pill" data-tone="client">
                          {t('WorkBoard.clientReview')}
                        </span>
                      ) : null}
                      <div className="tm-wk-card-tile__foot">
                        <span className="tm-wk-card-tile__date">
                          {day === ''
                            ? t('WorkBoard.noDue')
                            : t(finished ? 'WorkBoard.doneOn' : 'WorkBoard.dueOn', {
                                day: formatShortDay(day, locale),
                              })}
                        </span>
                        {item.ownerUserId !== null ? (
                          <span className="tm-wk-orb" title={name}>
                            <span aria-hidden="true">{initialsOf(name)}</span>
                            <span className="tm-visually-hidden">{name}</span>
                          </span>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </div>
    </section>
  );
}

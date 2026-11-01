'use client';

import { useMemo, useState, type DragEvent } from 'react';
import Link from 'next/link';
import { InlineAlert } from '@tmanage/ui';
import { workItemStateMachine, type WorkItemState } from '@tmanage/domain';
import { transitionWorkItem, type WorkItemSummary } from '../../lib/api/work-items';
import type { ApiClient } from '../../lib/api/client';
import { ApiRequestError } from '../../lib/api/errors';
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

/** The state a card dropped on a column lands in. */
const DROP_STATE: Record<BoardColumn, WorkItemState> = {
  todo: 'ready',
  in_progress: 'in_progress',
  in_review: 'internal_review',
  done: 'done',
};

/**
 * The legal steps from `from` to `to` that a drag can make on its own: moves that need nothing
 * typed in, plus `done`, whose owner and completion time the board supplies. Anything that needs
 * a reason (blocking, resolving a blocker, reopening) is `null` — the item page asks for it.
 */
export function dragPath(
  from: WorkItemState,
  to: WorkItemState,
  hasOwner: boolean,
): readonly WorkItemState[] | null {
  if (from === to) return [];
  const queue: (readonly WorkItemState[])[] = [[from]];
  const seen = new Set<WorkItemState>([from]);
  while (queue.length > 0) {
    const path = queue.shift() as readonly WorkItemState[];
    const at = path[path.length - 1] as WorkItemState;
    for (const next of workItemStateMachine.allowedFrom(at)) {
      if (seen.has(next) || next === 'archived' || next === 'blocked') continue;
      const needs = workItemStateMachine.requirementsFor(at, next);
      const supplied =
        next === 'done'
          ? hasOwner && needs.every((fact) => fact === 'ownerId' || fact === 'completedAt')
          : needs.length === 0;
      if (!supplied) continue;
      if (next === to) return [...path.slice(1), next];
      if (next === 'done') continue;
      seen.add(next);
      queue.push([...path, next]);
    }
  }
  return null;
}

/** Where a card dropped on `column` would go, or `null` when the drop changes nothing. */
export function dropTarget(state: WorkItemState, column: BoardColumn): WorkItemState | null {
  return columnOf(state) === column ? null : DROP_STATE[column];
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
  /**
   * WK-03 (Figma 157:224): with a client the cards can be dragged between columns, each drop
   * sent as the lifecycle's own transitions. Without one the board is read-only.
   */
  readonly api?: ApiClient;
  /** Called after a drop has moved a card, so the list behind the board is re-read. */
  readonly onMoved?: () => void;
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
  api,
  onMoved,
}: WorkBoardViewProps) {
  const t = useA6T();
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<BoardColumn | null>(null);
  const [refused, setRefused] = useState<{ title: string; reason: string } | null>(null);

  const [moving, setMoving] = useState(false);

  /** Sends a drop as the lifecycle's own transitions, one step at a time. */
  async function moveItem(item: WorkItemSummary, path: readonly WorkItemState[]) {
    if (!api) return;
    setMoving(true);
    try {
      let current = item;
      for (const to of path) {
        current = await transitionWorkItem(api, organizationSlug, item.id, {
          version: current.version,
          to,
          facts:
            to === 'done' && current.ownerUserId !== null
              ? { ownerId: current.ownerUserId, completedAt: new Date().toISOString() }
              : {},
        });
      }
      setRefused(null);
    } catch (error) {
      setRefused({
        title: item.title,
        reason: error instanceof ApiRequestError ? error.message : t('WorkBoard.moveFailed'),
      });
    } finally {
      setMoving(false);
      onMoved?.();
    }
  }

  function drop(event: DragEvent<HTMLElement>, column: BoardColumn) {
    event.preventDefault();
    setOver(null);
    const id = event.dataTransfer.getData('text/plain') || dragging;
    setDragging(null);
    const item = items.find((candidate) => candidate.id === id);
    if (!item) return;
    const target = dropTarget(item.state, column);
    if (target === null) return;
    const path = dragPath(item.state, target, item.ownerUserId !== null);
    if (path === null || path.length === 0) {
      setRefused({
        title: item.title,
        reason:
          target === 'done' && item.ownerUserId === null
            ? t('WorkBoard.moveNeedsOwner')
            : t('WorkBoard.moveNeedsDetail'),
      });
      return;
    }
    void moveItem(item, path);
  }
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

      {refused ? (
        <InlineAlert tone="danger" title={t('WorkBoard.moveNotAllowed')} live>
          {t('WorkBoard.moveNotAllowedBody', { title: refused.title, reason: refused.reason })}
        </InlineAlert>
      ) : null}

      <div className="tm-wk-board" aria-busy={moving || undefined}>
        {COLUMNS.map((column) => {
          const cards = shown.filter((item) => columnOf(item.state) === column.id);
          const headingId = `tm-wk-board-${column.id}`;
          return (
            <section
              key={column.id}
              className="tm-wk-board__column"
              aria-labelledby={headingId}
              data-drop-over={over === column.id || undefined}
              {...(api
                ? {
                    onDragOver: (event: DragEvent<HTMLElement>) => {
                      if (dragging === null) return;
                      event.preventDefault();
                      event.dataTransfer.dropEffect = 'move';
                      if (over !== column.id) setOver(column.id);
                    },
                    onDragLeave: (event: DragEvent<HTMLElement>) => {
                      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                        setOver((current) => (current === column.id ? null : current));
                      }
                    },
                    onDrop: (event: DragEvent<HTMLElement>) => drop(event, column.id),
                  }
                : {})}
            >
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
                    <li
                      key={item.id}
                      className="tm-wk-card-tile"
                      data-dragging={dragging === item.id || undefined}
                      {...(api
                        ? {
                            draggable: true,
                            onDragStart: (event: DragEvent<HTMLLIElement>) => {
                              event.dataTransfer.setData('text/plain', item.id);
                              event.dataTransfer.effectAllowed = 'move';
                              setDragging(item.id);
                              setRefused(null);
                            },
                            onDragEnd: () => {
                              setDragging(null);
                              setOver(null);
                            },
                          }
                        : {})}
                    >
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

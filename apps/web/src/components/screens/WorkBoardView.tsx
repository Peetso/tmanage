'use client';

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import Link from 'next/link';
import { InlineAlert } from '@tmanage/ui';
import { workItemStateMachine, type WorkItemState } from '@tmanage/domain';
import { transitionWorkItem, updateWorkItem, type WorkItemSummary } from '../../lib/api/work-items';
import type { ApiClient } from '../../lib/api/client';
import { ApiRequestError } from '../../lib/api/errors';
import type { MemberSummary } from '../../lib/api/members';
import { memberDisplayName } from '../../lib/members-presentation';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import { useTOr } from '../../lib/i18n/use-t-or';
import { addDays, dayOf, formatShortDay, todayOf, useA6T } from '../work/DueDatePicker';
import { DoerStack } from '../work/WorkPeopleBlock';
import { byRank, rankForDrop, type WorkDragPermissions } from '../../lib/work-drag';
import './work-core.css';
import './work-board-move.css';

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
  /**
   * FIX3 item C: what the caller may do (`useWorkDragPermissions`). A client or a viewer gets
   * neither, and the board is then read-only. Omitted, a board with an `api` may do both.
   */
  readonly dragRights?: WorkDragPermissions;
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
  dragRights,
}: WorkBoardViewProps) {
  const t = useA6T();
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<BoardColumn | null>(null);
  const [overCard, setOverCard] = useState<string | null>(null);
  const [refused, setRefused] = useState<{ title: string; reason: string } | null>(null);
  // FIX3 item C: what a drop changed, shown at once, and dropped again when the list is re-read
  // (success) or when the API refuses (rollback).
  const [overrides, setOverrides] = useState<
    ReadonlyMap<string, { readonly state?: WorkItemState; readonly rank?: number }>
  >(() => new Map());
  const rights = dragRights ?? { canUpdate: true, canTransition: true };
  const canMove = api !== undefined && rights.canTransition;
  const canReorder = api !== undefined && rights.canUpdate;
  const canDrag = canMove || canReorder;

  const [moving, setMoving] = useState(false);

  useEffect(() => {
    setOverrides(new Map());
  }, [items]);

  const view = useMemo(
    () =>
      items.map((item) => {
        const change = overrides.get(item.id);
        return change ? { ...item, ...change } : item;
      }),
    [items, overrides],
  );

  function override(id: string, change: { state?: WorkItemState; rank?: number } | null) {
    setOverrides((current) => {
      const next = new Map(current);
      if (change === null) next.delete(id);
      else next.set(id, { ...next.get(id), ...change });
      return next;
    });
  }

  /**
   * Sends a drop: the lifecycle's own transitions one step at a time, then the card's new place
   * in its column. Optimistic — the card shows where it was dropped at once — and rolled back
   * with a message when the API refuses.
   */
  async function moveItem(
    item: WorkItemSummary,
    path: readonly WorkItemState[],
    rank: number | null = null,
  ) {
    if (!api) return;
    setMoving(true);
    override(item.id, {
      ...(path.length > 0 ? { state: path[path.length - 1] as WorkItemState } : {}),
      ...(rank === null ? {} : { rank }),
    });
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
      if (rank !== null) {
        await updateWorkItem(api, organizationSlug, item.id, { version: current.version, rank });
      }
      setRefused(null);
    } catch (error) {
      override(item.id, null);
      setRefused({
        title: item.title,
        reason: error instanceof ApiRequestError ? error.message : t('WorkBoard.moveFailed'),
      });
    } finally {
      setMoving(false);
      onMoved?.();
    }
  }

  function drop(event: DragEvent<HTMLElement>, column: BoardColumn, beforeId: string | null) {
    event.preventDefault();
    event.stopPropagation();
    setOver(null);
    setOverCard(null);
    const id = event.dataTransfer.getData('text/plain') || dragging;
    setDragging(null);
    const item = view.find((candidate) => candidate.id === id);
    if (!item || beforeId === item.id) return;
    placeInColumn(item, column, beforeId);
  }

  /** A column's cards in their hand-made order — every card, whatever the filters show. */
  function columnCards(column: BoardColumn): WorkItemSummary[] {
    return byRank(view.filter((candidate) => columnOf(candidate.state) === column));
  }

  /**
   * A drop on a column — before the card `beforeId`, or at the end — or a pick from a card's
   * Move menu (WCAG 2.5.7: dragging is never the only way). Another column changes the status;
   * a place inside the column changes the order.
   */
  function placeInColumn(item: WorkItemSummary, column: BoardColumn, beforeId: string | null) {
    const target = dropTarget(item.state, column);
    const ordered = columnCards(column);
    if (target === null) {
      const rank = canReorder ? rankForDrop(ordered, item.id, beforeId) : null;
      if (rank !== null) void moveItem(item, [], rank);
      return;
    }
    if (!canMove) {
      setRefused({ title: item.title, reason: t('WorkBoard.moveNeedsDetail') });
      return;
    }
    // Dropped on a card of another column: it also takes that place in the order.
    const rank =
      canReorder && beforeId !== null ? rankForDrop([...ordered, item], item.id, beforeId) : null;
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
    void moveItem(item, path, rank);
  }

  function moveToColumn(item: WorkItemSummary, column: BoardColumn) {
    placeInColumn(item, column, null);
  }

  /**
   * FIX4 item 7 (B12): a state the columns do not tell apart — Backlog shares To do with Ready —
   * picked from the Move menu.
   */
  function moveToState(item: WorkItemSummary, target: WorkItemState) {
    if (item.state === target) return;
    const path = dragPath(item.state, target, item.ownerUserId !== null);
    if (path === null || path.length === 0) {
      setRefused({ title: item.title, reason: t('WorkBoard.moveNeedsDetail') });
      return;
    }
    void moveItem(item, path);
  }

  /** The keyboard path for the order: one place up or down inside the column. */
  function nudge(item: WorkItemSummary, column: BoardColumn, step: -1 | 1) {
    const ordered = columnCards(column);
    const index = ordered.findIndex((candidate) => candidate.id === item.id);
    if (index === -1) return;
    // Up: before the card above. Down: before the card two below (or last).
    const beforeId =
      step === -1 ? (ordered[index - 1]?.id ?? null) : (ordered[index + 2]?.id ?? null);
    if (step === -1 && index === 0) return;
    if (step === 1 && index === ordered.length - 1) return;
    const rank = rankForDrop(ordered, item.id, beforeId);
    if (rank !== null) void moveItem(item, [], rank);
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

  const shown = view.filter(
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
          const cards = byRank(shown.filter((item) => columnOf(item.state) === column.id));
          const headingId = `tm-wk-board-${column.id}`;
          return (
            <section
              key={column.id}
              className="tm-wk-board__column"
              aria-labelledby={headingId}
              data-drop-over={over === column.id || undefined}
              {...(canDrag
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
                    onDrop: (event: DragEvent<HTMLElement>) => drop(event, column.id, null),
                  }
                : {})}
            >
              <h2 id={headingId} className="tm-wk-board__heading">
                <span>{t(column.key)}</span>
                <span className="tm-wk-count">{cards.length}</span>
              </h2>
              <ul className="tm-wk-board__cards">
                {cards.map((item, index) => {
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
                      data-drop-before={
                        (overCard === item.id && dragging !== null && dragging !== item.id) ||
                        undefined
                      }
                      data-done={item.state === 'done' || undefined}
                      {...(canDrag
                        ? {
                            draggable: true,
                            onDragStart: (event: DragEvent<HTMLLIElement>) => {
                              event.dataTransfer.setData('text/plain', item.id);
                              event.dataTransfer.effectAllowed = 'move';
                              setDragging(item.id);
                              setRefused(null);
                            },
                            // FIX3 item C: a drop on a card puts the dragged one just before it.
                            onDragOver: (event: DragEvent<HTMLLIElement>) => {
                              if (dragging === null) return;
                              event.preventDefault();
                              event.dataTransfer.dropEffect = 'move';
                              if (overCard !== item.id) setOverCard(item.id);
                            },
                            onDrop: (event: DragEvent<HTMLLIElement>) =>
                              drop(event, column.id, item.id),
                            onDragEnd: () => {
                              setDragging(null);
                              setOver(null);
                              setOverCard(null);
                            },
                          }
                        : {})}
                    >
                      <Link
                        className="tm-wk-card-tile__title"
                        // QA-FIX-R L3: a title's direction is its own, not the page's (W3C
                        // dir=auto for user text), so "Friday?" keeps its "?" in an Arabic board.
                        dir="auto"
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
                        {/* C27: every doer, lead first — three avatars, then "+N". */}
                        <DoerStack
                          doerUserIds={item.doerUserIds}
                          ownerUserId={item.ownerUserId}
                          nameOf={(id) =>
                            id === item.ownerUserId
                              ? name
                              : memberDisplayName(id, members, membersPending)
                          }
                        />
                        {canDrag ? (
                          <BoardMoveMenu
                            title={item.title}
                            current={column.id}
                            disabled={moving}
                            onMove={(target) =>
                              target === 'todo' && item.state === 'backlog'
                                ? moveToState(item, 'ready')
                                : moveToColumn(item, target)
                            }
                            {...(canMove
                              ? {
                                  inBacklog: item.state === 'backlog',
                                  onBacklog: () => moveToState(item, 'backlog'),
                                }
                              : {})}
                            {...(canReorder && index > 0
                              ? { onUp: () => nudge(item, column.id, -1) }
                              : {})}
                            {...(canReorder && index < cards.length - 1
                              ? { onDown: () => nudge(item, column.id, 1) }
                              : {})}
                          />
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

/**
 * The keyboard and pointer alternative to dragging a card (WCAG 2.2 — 2.5.7 Dragging Movements;
 * Figma `R42 L2-55-12-keyboard`, "Move" button and "Move to" menu). A button opens the list of
 * columns; the current one is marked and disabled, Escape closes and returns focus to the button.
 */
export function BoardMoveMenu({
  title,
  current,
  disabled,
  onMove,
  inBacklog = false,
  onBacklog,
  onUp,
  onDown,
}: {
  readonly title: string;
  readonly current: BoardColumn;
  readonly disabled?: boolean;
  readonly onMove: (column: BoardColumn) => void;
  /** FIX4 item 7: the card is in the backlog (the To do column also holds Ready work). */
  readonly inBacklog?: boolean;
  /** FIX4 item 7: put the card back in the backlog. */
  readonly onBacklog?: () => void;
  /** FIX3 item C: the keyboard path for the hand-made order — one place up in the column. */
  readonly onUp?: () => void;
  /** One place down in the column. */
  readonly onDown?: () => void;
}) {
  const t = useA6T();
  const tOr = useTOr();
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    if (open) listRef.current?.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus();
  }, [open]);

  function close() {
    setOpen(false);
    buttonRef.current?.focus();
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  }

  return (
    <div className="tm-wk-move">
      <button
        ref={buttonRef}
        type="button"
        className="tm-wk-move__button"
        aria-expanded={open}
        aria-label={tOr('WorkBoard.moveLabel', 'Move {title}').replace('{title}', title)}
        disabled={disabled}
        onKeyDown={onKeyDown}
        onClick={() => setOpen((value) => !value)}
      >
        {tOr('WorkBoard.move', 'Move')}
      </button>
      {open ? (
        <div className="tm-wk-move__menu">
          <p className="tm-wk-move__heading">{tOr('WorkBoard.moveTo', 'Move to')}</p>
          <ul ref={listRef} className="tm-wk-move__list">
            {onBacklog ? (
              <li>
                <button
                  type="button"
                  className="tm-wk-move__item"
                  disabled={inBacklog}
                  onKeyDown={onKeyDown}
                  onClick={() => {
                    close();
                    onBacklog();
                  }}
                >
                  {t('WorkListScreen.stateBacklog')}
                  {inBacklog ? ` · ${tOr('WorkBoard.moveCurrent', 'current')}` : ''}
                </button>
              </li>
            ) : null}
            {COLUMNS.map((column) => {
              const here = column.id === current && !(onBacklog && inBacklog);
              return (
                <li key={column.id}>
                  <button
                    type="button"
                    className="tm-wk-move__item"
                    disabled={here}
                    onKeyDown={onKeyDown}
                    onClick={() => {
                      close();
                      onMove(column.id);
                    }}
                  >
                    {t(column.key)}
                    {here ? ` · ${tOr('WorkBoard.moveCurrent', 'current')}` : ''}
                  </button>
                </li>
              );
            })}
            {onUp ? (
              <li>
                <button
                  type="button"
                  className="tm-wk-move__item"
                  onKeyDown={onKeyDown}
                  onClick={() => {
                    close();
                    onUp();
                  }}
                >
                  {tOr('WorkBoard.moveUp', 'Up one place')}
                </button>
              </li>
            ) : null}
            {onDown ? (
              <li>
                <button
                  type="button"
                  className="tm-wk-move__item"
                  onKeyDown={onKeyDown}
                  onClick={() => {
                    close();
                    onDown();
                  }}
                >
                  {tOr('WorkBoard.moveDown', 'Down one place')}
                </button>
              </li>
            ) : null}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

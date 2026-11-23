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
import type { StageGroup, StageSetView, StageView } from '../../lib/api/work-stages';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import { useTOr } from '../../lib/i18n/use-t-or';
import { useA6T } from '../work/DueDatePicker';
import { byRank, rankForDrop, type WorkDragPermissions } from '../../lib/work-drag';
import {
  autoFacts,
  groupColorVar,
  movesTo,
  orderedStages,
  stageColorVar,
} from '../work/stages/stage-model';
import { moveToStage } from '../work/stages/move-to-stage';
import { MoreIcon } from '../work/work-icons';
import { GROUP_NAME_KEY } from '../work/list/WorkFilterBar';
import { ClientName, Faces, WorkStageCapsule, formatDueDay } from '../work/list/WorkListParts';
import { doersOf } from '../work/list/work-list-model';
import './work-core.css';
import './work-board-move.css';
import '../work/list/work-list.css';

/** The four group columns of "All projects" (and of a project on the built-in stages). */
export type BoardColumn = 'todo' | 'in_progress' | 'in_review' | 'done';

/** Which group column each lifecycle state sits in. Archived work is off the board. */
const COLUMN_OF: Record<WorkItemState, BoardColumn | null> = {
  backlog: 'todo',
  ready: 'todo',
  in_progress: 'in_progress',
  blocked: 'in_progress',
  internal_review: 'in_review',
  done: 'done',
  archived: null,
};

const GROUP_OF_COLUMN: Record<BoardColumn, StageGroup> = {
  todo: 'not_started',
  in_progress: 'in_progress',
  in_review: 'in_review',
  done: 'done',
};

const GROUP_COLUMNS: readonly BoardColumn[] = ['todo', 'in_progress', 'in_review', 'done'];

export function columnOf(state: WorkItemState): BoardColumn | null {
  return COLUMN_OF[state] ?? null;
}

/** The state a card dropped on a group column lands in. */
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

/** Where a card dropped on group `column` would go, or `null` when the drop changes nothing. */
export function dropTarget(state: WorkItemState, column: BoardColumn): WorkItemState | null {
  return columnOf(state) === column ? null : DROP_STATE[column];
}

/**
 * The stage column a work sits in on a project's set: its stored stage, else the first stage of
 * its state; a blocked work stays on its stage, or the first "in progress" one. Archived: none.
 */
export function stageColumnOf(item: WorkItemSummary, stages: readonly StageView[]): string | null {
  if (item.state === 'archived') return null;
  const stored = item.stageId ? stages.find((stage) => stage.id === item.stageId) : undefined;
  if (stored) return stored.id;
  const byState =
    item.state === 'blocked'
      ? stages.find((stage) => stage.group === 'in_progress')
      : (stages.find((stage) => stage.stateKey === item.state) ??
        stages.find((stage) => stage.stateKey === 'ready' && item.state === 'backlog'));
  return byState?.id ?? null;
}

interface ColumnDef {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  /** Set on a project's stage column; `null` on a group column. */
  readonly stage: StageView | null;
}

export interface WorkBoardViewProps {
  readonly organizationSlug: string;
  readonly items: readonly WorkItemSummary[];
  /** The member names for the faces. */
  readonly nameOf: (userId: string) => string;
  readonly clientNameOf?: (clientOrganizationId: string) => string | undefined;
  /**
   * The chosen project's named stage set: its stages are the columns (Figma `939:101782`).
   * `null` (all projects, or the built-in stages): the four groups, each card with its own stage.
   */
  readonly stageSet?: StageSetView | null;
  /** Every set the cards may use, for a card's stage colour in the group columns. */
  readonly sets?: readonly StageSetView[];
  /** "Add work" under a column: where it goes (the project and stage are carried). */
  readonly addHref?: (stage: StageView | null) => string;
  /**
   * WK-03 (Figma 157:224): with a client the cards can be dragged between columns, each drop
   * sent as the lifecycle's own moves. Without one the board is read-only.
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
 * **Board view (Work area v2, Figma `WV2-10` `939:101782`, AR `939:102379`, phones `939:102935`).**
 *
 * One project: a column per stage of its set, in the set's order. All projects: the four groups
 * (Not started · In progress · In review · Done), each card with its own stage capsule. A card is
 * the title, the doers' faces and the due day, then the client or "Internal". Cards move by drag,
 * or by the Move menu that shows on hover and focus (WCAG 2.2 — 2.5.7). On a phone the columns
 * become tabs that scroll sideways over one column of cards.
 */
export function WorkBoardView({
  organizationSlug,
  items,
  nameOf,
  clientNameOf = () => undefined,
  stageSet = null,
  sets = [],
  addHref,
  api,
  onMoved,
  dragRights,
}: WorkBoardViewProps) {
  const t = useA6T();
  const locale = useActiveLocale();
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [overCard, setOverCard] = useState<string | null>(null);
  const [refused, setRefused] = useState<{ title: string; reason: string } | null>(null);
  const [phoneColumn, setPhoneColumn] = useState<string | null>(null);
  // FIX3 item C: what a drop changed, shown at once, and dropped again when the list is re-read
  // (success) or when the API refuses (rollback).
  const [overrides, setOverrides] = useState<
    ReadonlyMap<
      string,
      { readonly state?: WorkItemState; readonly rank?: number; readonly stageId?: string }
    >
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

  const stages = useMemo(
    () => (stageSet && !stageSet.isBuiltIn ? orderedStages(stageSet.stages) : null),
    [stageSet],
  );
  const columns: readonly ColumnDef[] = stages
    ? stages.map((stage) => ({
        id: stage.id,
        name: stage.name,
        color: stageColorVar(stage),
        stage,
      }))
    : GROUP_COLUMNS.map((column) => ({
        id: column,
        name: t(GROUP_NAME_KEY[GROUP_OF_COLUMN[column]]),
        color: groupColorVar(GROUP_OF_COLUMN[column]),
        stage: null,
      }));

  const placeOf = (item: WorkItemSummary): string | null =>
    stages ? stageColumnOf(item, stages) : columnOf(item.state);

  function override(
    id: string,
    change: { state?: WorkItemState; rank?: number; stageId?: string } | null,
  ) {
    setOverrides((current) => {
      const next = new Map(current);
      if (change === null) next.delete(id);
      else next.set(id, { ...next.get(id), ...change });
      return next;
    });
  }

  function refuse(item: WorkItemSummary, error: unknown) {
    setRefused({
      title: item.title,
      reason: error instanceof ApiRequestError ? error.message : t('WorkBoard.moveFailed'),
    });
  }

  /**
   * Sends a group-column drop: the lifecycle's own transitions one step at a time, then the
   * card's new place in its column. Optimistic, and rolled back with a message on a refusal.
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
      refuse(item, error);
    } finally {
      setMoving(false);
      onMoved?.();
    }
  }

  /** A stage-column drop: the ordinary moves to the stage's state, then the stage itself. */
  async function moveToStageColumn(item: WorkItemSummary, stage: StageView, rank: number | null) {
    if (!api) return;
    setMoving(true);
    override(item.id, { stageId: stage.id, state: stage.stateKey as WorkItemState });
    try {
      const moved = await moveToStage(api, organizationSlug, item, stage);
      if (moved === null) throw new Error(t('WorkBoard.moveNeedsDetail'));
      if (rank !== null) {
        await updateWorkItem(api, organizationSlug, item.id, { version: moved.version, rank });
      }
      setRefused(null);
    } catch (error) {
      override(item.id, null);
      setRefused({
        title: item.title,
        reason:
          error instanceof ApiRequestError || error instanceof Error
            ? error.message
            : t('WorkBoard.moveFailed'),
      });
    } finally {
      setMoving(false);
      onMoved?.();
    }
  }

  function drop(event: DragEvent<HTMLElement>, column: string, beforeId: string | null) {
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

  /** A column's cards in their hand-made order. */
  function columnCards(column: string): WorkItemSummary[] {
    return byRank(view.filter((candidate) => placeOf(candidate) === column));
  }

  /**
   * A drop on a column — before the card `beforeId`, or at the end — or a pick from a card's
   * Move menu (WCAG 2.5.7: dragging is never the only way). Another column changes the stage
   * or the state; a place inside the column changes the order.
   */
  function placeInColumn(item: WorkItemSummary, column: string, beforeId: string | null) {
    const ordered = columnCards(column);
    if (placeOf(item) === column) {
      const rank = canReorder ? rankForDrop(ordered, item.id, beforeId) : null;
      if (rank !== null) void moveItem(item, [], rank);
      return;
    }
    if (!canMove) {
      setRefused({ title: item.title, reason: t('WorkBoard.moveNeedsDetail') });
      return;
    }
    const rank =
      canReorder && beforeId !== null ? rankForDrop([...ordered, item], item.id, beforeId) : null;
    const stage = stages?.find((candidate) => candidate.id === column);
    if (stage) {
      const run = movesTo(item.state, stage.stateKey as WorkItemState);
      const ask = run === null ? ['state'] : autoFacts(run.needs, item.ownerUserId, new Date()).ask;
      if (ask.length > 0) {
        setRefused({
          title: item.title,
          reason: t(
            ask.includes('ownerId') ? 'WorkBoard.moveNeedsOwner' : 'WorkBoard.moveNeedsDetail',
          ),
        });
        return;
      }
      void moveToStageColumn(item, stage, rank);
      return;
    }
    const target = dropTarget(item.state, column as BoardColumn);
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
    void moveItem(item, path, rank);
  }

  /**
   * FIX4 item 7 (B12): a state the group columns do not tell apart — Backlog shares Not started
   * with Ready — picked from the Move menu.
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
  function nudge(item: WorkItemSummary, column: string, step: -1 | 1) {
    const ordered = columnCards(column);
    const index = ordered.findIndex((candidate) => candidate.id === item.id);
    if (index === -1) return;
    if (step === -1 && index === 0) return;
    if (step === 1 && index === ordered.length - 1) return;
    const beforeId =
      step === -1 ? (ordered[index - 1]?.id ?? null) : (ordered[index + 2]?.id ?? null);
    const rank = rankForDrop(ordered, item.id, beforeId);
    if (rank !== null) void moveItem(item, [], rank);
  }

  const shownPhone = phoneColumn ?? columns[0]?.id ?? null;
  const menuColumns = columns.map((column) => ({ id: column.id, label: column.name }));

  return (
    <section className="tm-wl-board-frame" aria-label={t('WorkBoard.label')}>
      {refused ? (
        <InlineAlert tone="danger" title={t('WorkBoard.moveNotAllowed')} live>
          {t('WorkBoard.moveNotAllowedBody', { title: refused.title, reason: refused.reason })}
        </InlineAlert>
      ) : null}

      {/* Phone (Figma `939:102935`): the columns as tabs that scroll sideways. */}
      <div className="tm-wl-board-tabs" role="group" aria-label={t('WorkListScreen.boardColumns')}>
        {columns.map((column) => (
          <button
            key={column.id}
            type="button"
            className="tm-wl-board-tab"
            aria-pressed={shownPhone === column.id}
            onClick={() => setPhoneColumn(column.id)}
          >
            <span className="tm-wl-dot" style={{ background: column.color }} aria-hidden="true" />
            <bdi>{column.name}</bdi>
            <span className="tm-wl-count">{columnCards(column.id).length}</span>
          </button>
        ))}
      </div>

      <div className="tm-wl-board" aria-busy={moving || undefined}>
        {columns.map((column) => {
          const cards = columnCards(column.id);
          const headingId = `tm-wl-board-${column.id}`;
          return (
            <section
              key={column.id}
              className="tm-wl-column"
              aria-labelledby={headingId}
              data-phone-shown={shownPhone === column.id || undefined}
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
              <h2 id={headingId} className="tm-wl-column__heading">
                <span
                  className="tm-wl-dot"
                  style={{ background: column.color }}
                  aria-hidden="true"
                />
                <bdi className="tm-wl-column__name">{column.name}</bdi>
                <span className="tm-wl-count">{cards.length}</span>
              </h2>
              <ul className="tm-wl-column__cards">
                {cards.map((item, index) => (
                  <li
                    key={item.id}
                    className="tm-wl-card"
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
                    {stages ? null : (
                      <span className="tm-wl-card__stage">
                        <WorkStageCapsule item={item} sets={sets} />
                      </span>
                    )}
                    <Link
                      className="tm-wl-card__title"
                      // QA-FIX-R L3: a title's direction is its own, not the page's (W3C
                      // dir=auto for user text), so "Friday?" keeps its "?" in an Arabic board.
                      dir="auto"
                      href={`/${organizationSlug}/work/${item.id}`}
                    >
                      {item.title}
                    </Link>
                    <span className="tm-wl-card__meta">
                      <Faces ids={doersOf(item)} nameOf={nameOf} max={2} />
                      {item.dueAt === null ? null : (
                        <time className="tm-wl-card__due" dateTime={item.dueAt}>
                          {formatDueDay(item.dueAt, locale)}
                        </time>
                      )}
                    </span>
                    <ClientName item={item} nameOf={clientNameOf} />
                    {canDrag ? (
                      <BoardMoveMenu
                        title={item.title}
                        current={column.id}
                        columns={menuColumns}
                        disabled={moving}
                        onMove={(target) =>
                          !stages && target === 'todo' && item.state === 'backlog'
                            ? moveToState(item, 'ready')
                            : placeInColumn(item, target, null)
                        }
                        {...(canMove && !stages
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
                  </li>
                ))}
              </ul>
              {addHref ? (
                <Link className="tm-wl-column__add" href={addHref(column.stage)}>
                  {t('WorkListScreen.addWork')}
                </Link>
              ) : null}
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
  columns,
  disabled,
  onMove,
  inBacklog = false,
  onBacklog,
  onUp,
  onDown,
}: {
  readonly title: string;
  readonly current: string;
  /** The board's columns; omitted, the four group columns. */
  readonly columns?: readonly { readonly id: string; readonly label: string }[];
  readonly disabled?: boolean;
  readonly onMove: (column: string) => void;
  /** FIX4 item 7: the card is in the backlog (Not started also holds Ready work). */
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
  const list =
    columns ??
    GROUP_COLUMNS.map((column) => ({
      id: column,
      label: t(GROUP_NAME_KEY[GROUP_OF_COLUMN[column]]),
    }));

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
    <div className="tm-wk-move" data-open={open || undefined}>
      <button
        ref={buttonRef}
        type="button"
        className="tm-wk-move__button"
        aria-expanded={open}
        aria-label={tOr('WorkBoard.moveLabel', 'Move {title}').replace('{title}', title)}
        title={tOr('WorkBoard.move', 'Move')}
        disabled={disabled}
        onKeyDown={onKeyDown}
        onClick={() => setOpen((value) => !value)}
      >
        <MoreIcon />
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
            {list.map((column) => {
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
                    <bdi>{column.label}</bdi>
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

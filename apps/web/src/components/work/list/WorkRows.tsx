'use client';

import type { DragEvent } from 'react';
import Link from 'next/link';
import type { StageSetView } from '../../../lib/api/work-stages';
import type { WorkItemSummary } from '../../../lib/api/work-items';
import { isOverdue } from '../../../lib/work-item-presentation';
import { useActiveLocale } from '../../../lib/i18n/use-active-locale';
import { useA6T } from '../DueDatePicker';
import { CheckIcon, ChevronDownIcon, DragIcon } from '../work-icons';
import { ClientName, Faces, WorkStageCapsule, formatAge, formatDueDay } from './WorkListParts';
import { doersOf } from './work-list-model';

export type SortKey = 'loaded' | 'title' | 'stage' | 'due' | 'updated';
export type SortDirection = 'asc' | 'desc';

export interface WorkRowsProps {
  readonly organizationSlug: string;
  readonly rows: readonly WorkItemSummary[];
  readonly now: Date;
  readonly sets: readonly StageSetView[];
  readonly nameOf: (userId: string) => string;
  readonly clientNameOf: (clientOrganizationId: string) => string | undefined;
  readonly sortKey: SortKey;
  readonly sortDirection: SortDirection;
  readonly onSort: (key: Exclude<SortKey, 'loaded'>) => void;
  readonly selected: ReadonlySet<string>;
  readonly onToggleRow: (id: string) => void;
  readonly onToggleAll: () => void;
  /** The row tick: done, or sent for review when a supervisor approves it. */
  readonly onTick: (item: WorkItemSummary) => void;
  /** Ids whose tick is being sent. */
  readonly ticking: ReadonlySet<string>;
  /** The hand-made order (FIX3 item C); omitted when the reader may not reorder or a sort is on. */
  readonly reorder?: {
    readonly dragging: string | null;
    readonly over: string | null;
    readonly onDragStart: (id: string) => void;
    readonly onDragOver: (id: string) => void;
    readonly onDrop: (id: string, onto: string) => void;
    readonly onDragEnd: () => void;
    readonly onNudge: (item: WorkItemSummary, step: -1 | 1) => void;
  };
  /** Screen-reader caption: what the table holds. */
  readonly caption: string;
}

/**
 * The Works table (Figma `WV2-01`, `930:95062`): a round tick that marks the work done (the same
 * shape as a step), the title, the stage capsule, the doers' faces, the supervisor's, the due day,
 * the client and when it last changed. Selecting rows (for the bulk "who sees it" change) and the
 * hand-made order live in a gutter at the start that shows on hover and focus, so the resting
 * row is the design's and nothing is lost. On a phone the same rows become two-line cards
 * (`930:95709`): title and faces, then stage, due · client.
 */
export function WorkRows({
  organizationSlug,
  rows,
  now,
  sets,
  nameOf,
  clientNameOf,
  sortKey,
  sortDirection,
  onSort,
  selected,
  onToggleRow,
  onToggleAll,
  onTick,
  ticking,
  reorder,
  caption,
}: WorkRowsProps) {
  const t = useA6T();
  const locale = useActiveLocale();
  const allSelected = rows.length > 0 && rows.every((row) => selected.has(row.id));

  const header = (key: Exclude<SortKey, 'loaded'>, label: string, className: string) => (
    <th
      scope="col"
      className={className}
      aria-sort={
        sortKey === key ? (sortDirection === 'asc' ? 'ascending' : 'descending') : undefined
      }
    >
      <button type="button" className="tm-wl-sort" onClick={() => onSort(key)}>
        {label}
        {sortKey === key || key === 'due' ? (
          <span
            className="tm-wl-sort__mark"
            data-direction={sortKey === key ? sortDirection : 'asc'}
            aria-hidden="true"
          >
            <ChevronDownIcon />
          </span>
        ) : null}
      </button>
    </th>
  );

  return (
    <div className="tm-wl-frame" data-selecting={selected.size > 0 || undefined}>
      <table className="tm-wl-table">
        <caption className="tm-visually-hidden">{caption}</caption>
        <thead>
          <tr>
            <th scope="col" className="tm-wl-cell--gutter">
              <input
                className="tm-wl-select"
                type="checkbox"
                aria-label={t('WorkListScreen.selectAll')}
                checked={allSelected}
                onChange={onToggleAll}
              />
            </th>
            <th scope="col" className="tm-wl-cell--tick">
              <span className="tm-visually-hidden">{t('WorkListScreen.colDone')}</span>
            </th>
            {header('title', t('WorkListScreen.colTitle'), 'tm-wl-cell--title')}
            {header('stage', t('WorkPage.stage'), 'tm-wl-cell--stage')}
            <th scope="col" className="tm-wl-cell--doers">
              {t('WorkPage.doers')}
            </th>
            <th scope="col" className="tm-wl-cell--supervisor">
              {t('WorkPage.supervisor')}
            </th>
            {header('due', t('WorkPage.due'), 'tm-wl-cell--due')}
            <th scope="col" className="tm-wl-cell--client">
              {t('WorkPage.client')}
            </th>
            {header('updated', t('WorkListScreen.colUpdated'), 'tm-wl-cell--updated')}
          </tr>
        </thead>
        <tbody>
          {rows.map((item) => {
            const done = item.state === 'done';
            const overdue = isOverdue(item, now);
            const busy = ticking.has(item.id);
            const tickable = !done && item.state !== 'archived' && !busy;
            return (
              <tr
                key={item.id}
                data-selected={selected.has(item.id) || undefined}
                data-done={done || undefined}
                data-dragging={reorder?.dragging === item.id || undefined}
                data-drop-before={
                  (reorder !== undefined &&
                    reorder.over === item.id &&
                    reorder.dragging !== null &&
                    reorder.dragging !== item.id) ||
                  undefined
                }
                {...(reorder
                  ? {
                      draggable: true,
                      onDragStart: (event: DragEvent<HTMLTableRowElement>) => {
                        event.dataTransfer.setData('text/plain', item.id);
                        event.dataTransfer.effectAllowed = 'move';
                        reorder.onDragStart(item.id);
                      },
                      onDragOver: (event: DragEvent<HTMLTableRowElement>) => {
                        if (reorder.dragging === null) return;
                        event.preventDefault();
                        event.dataTransfer.dropEffect = 'move';
                        reorder.onDragOver(item.id);
                      },
                      onDrop: (event: DragEvent<HTMLTableRowElement>) => {
                        event.preventDefault();
                        const id = event.dataTransfer.getData('text/plain') || reorder.dragging;
                        if (id) reorder.onDrop(id, item.id);
                      },
                      onDragEnd: reorder.onDragEnd,
                    }
                  : {})}
              >
                <td className="tm-wl-cell--gutter">
                  <span className="tm-wl-gutter">
                    {reorder ? (
                      <button
                        type="button"
                        className="tm-wl-handle"
                        aria-label={t('WorkListScreen.reorderHandle', { title: item.title })}
                        title={t('WorkListScreen.reorderHint')}
                        onKeyDown={(event) => {
                          if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                            event.preventDefault();
                            reorder.onNudge(item, event.key === 'ArrowUp' ? -1 : 1);
                          }
                        }}
                      >
                        <DragIcon />
                      </button>
                    ) : null}
                    <input
                      className="tm-wl-select"
                      type="checkbox"
                      aria-label={`${t('WorkListScreen.selectRowPrefix')} ${item.title}`}
                      checked={selected.has(item.id)}
                      onChange={() => onToggleRow(item.id)}
                    />
                  </span>
                </td>
                <td className="tm-wl-cell--tick">
                  <button
                    type="button"
                    className="tm-wl-tick"
                    aria-pressed={done}
                    aria-label={t(done ? 'WorkListScreen.tickDone' : 'WorkListScreen.tickMark', {
                      title: item.title,
                    })}
                    disabled={!tickable}
                    aria-busy={busy || undefined}
                    onClick={() => onTick(item)}
                  >
                    {done ? <CheckIcon /> : null}
                  </button>
                </td>
                <th scope="row" className="tm-wl-cell--title">
                  <Link dir="auto" href={`/${organizationSlug}/work/${item.id}`}>
                    {item.title}
                  </Link>
                </th>
                <td className="tm-wl-cell--stage">
                  <WorkStageCapsule item={item} sets={sets} />
                </td>
                <td className="tm-wl-cell--doers">
                  <Faces
                    ids={doersOf(item)}
                    nameOf={nameOf}
                    emptyLabel={t('WorkListScreen.noDoer')}
                  />
                </td>
                <td className="tm-wl-cell--supervisor">
                  <Faces
                    ids={item.supervisorUserIds ?? []}
                    nameOf={nameOf}
                    emptyLabel={t('WorkListScreen.noSupervisor')}
                  />
                </td>
                <td className="tm-wl-cell--due">
                  {item.dueAt === null ? (
                    <span className="tm-wl-muted">{t('WorkListScreen.dueNotSet')}</span>
                  ) : (
                    <time
                      dateTime={item.dueAt}
                      className="tm-wl-due"
                      data-overdue={overdue || undefined}
                    >
                      {formatDueDay(item.dueAt, locale)}
                      {overdue ? (
                        <span className="tm-visually-hidden"> {t('WorkListScreen.overdue')}</span>
                      ) : null}
                    </time>
                  )}
                </td>
                <td className="tm-wl-cell--client">
                  <ClientName item={item} nameOf={clientNameOf} />
                </td>
                <td className="tm-wl-cell--updated">
                  <time
                    dateTime={item.updatedAt}
                    className="tm-wl-muted"
                    // Minutes since the change differ between the server render and hydration.
                    suppressHydrationWarning
                  >
                    {formatAge(item.updatedAt, now, locale)}
                  </time>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

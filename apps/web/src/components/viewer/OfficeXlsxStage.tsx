'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { InlineAlert } from '@tmanage/ui';
import type { PreviewOffice } from '../../lib/api/file-preview';
import type { ReviewThread } from '../../lib/api/review';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import { useT } from '../../lib/i18n/use-t';
import { columnName, readWorkbook } from '../../lib/office/xlsx-read';
import type { Workbook } from '../../lib/office/xlsx-read';
import { cellAnchorOf, fetchOriginal, useParsedOriginal } from './format-stage-helpers';
import type { OriginalFetcher } from './format-stage-helpers';
import { OfficeLoadState } from './OfficeLoadState';
import './format-stages.css';

/**
 * V-25 Excel (`468:28438` EN, `468:29463` AR): the workbook drawn as a plain grid in the browser
 * (values as Excel saved them, common number formats). Banner: "Layout is approximate — download
 * the original for the exact file". A comment anchors to a cell (`Rates!C7`): click a cell, or
 * move to it with the arrow keys and press Enter. The cell keeps its address whatever the grid
 * looks like, so the anchor is exact even though the drawing is approximate.
 *
 * The sheet stays left-to-right in Arabic too: it is the client's file, not our interface (batch C
 * decision 2). Everything around it mirrors.
 */

export interface CellRef {
  readonly sheet: string;
  readonly cell: string;
}

export interface OfficeXlsxStageProps {
  /** The original's absolute URL (API origin + `manifest.originalUrl`). */
  readonly src: string | null;
  readonly office: PreviewOffice | null;
  /** Threads on this version; only `cell` anchors are drawn. */
  readonly threads: readonly ReviewThread[];
  readonly selectedThreadId: string | null;
  readonly onSelectThread: (threadId: string) => void;
  /** Opens the composer for a cell; absent = read-only (Client Viewer, archived project). */
  readonly onCommentCell?: (cell: CellRef) => void;
  /** The cell a new comment is being written on (highlighted until posted or cancelled). */
  readonly draftCell?: CellRef | null;
  readonly onDownload?: () => void;
  /** Tests and stories hand in bytes without a network. */
  readonly fetcher?: OriginalFetcher;
}

function parseWorkbook(locale: string): (bytes: ArrayBuffer) => Promise<Workbook> {
  return (bytes) => readWorkbook(bytes, locale);
}

const parsers = new Map<string, (bytes: ArrayBuffer) => Promise<Workbook>>();
function parserFor(locale: string) {
  let parser = parsers.get(locale);
  if (!parser) {
    parser = parseWorkbook(locale);
    parsers.set(locale, parser);
  }
  return parser;
}

export function OfficeXlsxStage({
  src,
  office,
  threads,
  selectedThreadId,
  onSelectThread,
  onCommentCell,
  draftCell = null,
  onDownload,
  fetcher = fetchOriginal,
}: OfficeXlsxStageProps) {
  const t = useT();
  const locale = useActiveLocale();
  const loaded = useParsedOriginal(src, parserFor(locale), fetcher);
  const workbook = loaded.state === 'ready' ? loaded.value : null;
  const visibleSheets = useMemo(
    () => (workbook ? workbook.sheets.filter((sheet) => !sheet.hidden) : []),
    [workbook],
  );
  const [sheetName, setSheetName] = useState<string | null>(null);
  const [active, setActive] = useState<{ column: number; row: number }>({ column: 0, row: 0 });
  const gridRef = useRef<HTMLTableElement>(null);

  const anchored = useMemo(
    () =>
      threads
        .map((thread) => ({ thread, anchor: cellAnchorOf(thread) }))
        .filter((item): item is { thread: ReviewThread; anchor: CellRef } => item.anchor !== null),
    [threads],
  );

  // A thread chosen in the rail brings its sheet and cell forward.
  const selected = anchored.find((item) => item.thread.id === selectedThreadId) ?? null;
  useEffect(() => {
    if (!selected) return;
    setSheetName(selected.anchor.sheet);
  }, [selected?.anchor.sheet, selected]);

  const sheet =
    visibleSheets.find((candidate) => candidate.name === sheetName) ?? visibleSheets[0] ?? null;
  const onSheet = anchored.filter((item) => item.anchor.sheet === sheet?.name);
  const markers = new Map<string, ReviewThread[]>();
  for (const item of onSheet) {
    markers.set(item.anchor.cell, [...(markers.get(item.anchor.cell) ?? []), item.thread]);
  }
  const openBySheet = new Map<string, number>();
  for (const item of anchored) {
    if (item.thread.status !== 'open') continue;
    openBySheet.set(item.anchor.sheet, (openBySheet.get(item.anchor.sheet) ?? 0) + 1);
  }

  const rows = Math.max(sheet?.rowCount ?? 0, 12);
  const columns = Math.max(sheet?.columnCount ?? 0, 7);
  const focusCell = selected?.anchor.sheet === sheet?.name ? selected?.anchor.cell : null;
  const activeAddress = focusCell ?? `${columnName(active.column)}${active.row + 1}`;
  const activeValue = sheet?.cells.get(activeAddress)?.text ?? '';

  function comment(address: string) {
    if (!sheet || !onCommentCell) return;
    onCommentCell({ sheet: sheet.name, cell: address });
  }

  function move(event: ReactKeyboardEvent<HTMLTableElement>) {
    const delta: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    };
    if (event.key === 'Enter') {
      event.preventDefault();
      const threadsHere = markers.get(activeAddress);
      if (threadsHere?.[0]) onSelectThread(threadsHere[0].id);
      else comment(activeAddress);
      return;
    }
    const step = delta[event.key];
    if (!step) return;
    event.preventDefault();
    const next = {
      column: Math.min(columns - 1, Math.max(0, active.column + step[0])),
      row: Math.min(rows - 1, Math.max(0, active.row + step[1])),
    };
    setActive(next);
    const cell = gridRef.current?.querySelector<HTMLElement>(
      `[data-cell="${columnName(next.column)}${next.row + 1}"]`,
    );
    cell?.focus();
  }

  return (
    <div className="tm-office-stage tm-office-stage--xlsx">
      <InlineAlert tone="warning" className="tm-format-notice">
        {t('ViewerFormats.office.approximate')}
      </InlineAlert>
      {loaded.state !== 'ready' || !sheet ? (
        <OfficeLoadState
          state={loaded.state === 'ready' ? 'failed' : loaded.state}
          onDownload={onDownload}
        />
      ) : (
        <>
          <div className="tm-xlsx">
            <div className="tm-xlsx__bar" dir="ltr">
              <span className="tm-format-chip tm-format-chip--mono">{activeAddress}</span>
              <span className="tm-xlsx__value" aria-live="polite">
                {activeValue}
              </span>
            </div>
            <div className="tm-xlsx__scroll" dir="ltr">
              {/* The grid is one keyboard surface: arrows move the active cell, Enter comments. */}
              <table
                ref={gridRef}
                className="tm-xlsx__grid"
                role="grid"
                aria-label={t('ViewerFormats.xlsx.gridLabel').replace('{sheet}', sheet.name)}
                aria-readonly={!onCommentCell}
                onKeyDown={move}
              >
                <thead>
                  <tr>
                    <th className="tm-xlsx__corner" aria-hidden="true" />
                    {Array.from({ length: columns }, (_, column) => (
                      <th key={column} scope="col" className="tm-xlsx__col">
                        {columnName(column)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {Array.from({ length: rows }, (_, row) => (
                    <tr key={row}>
                      <th scope="row" className="tm-xlsx__row">
                        {row + 1}
                      </th>
                      {Array.from({ length: columns }, (_, column) => {
                        const address = `${columnName(column)}${row + 1}`;
                        // UX-1: a merged range is one cell; the addresses it covers are not drawn.
                        if (sheet.covered.has(address)) return null;
                        const merge = sheet.merges.get(address);
                        const cell = sheet.cells.get(address);
                        const here = markers.get(address) ?? [];
                        const isDraft =
                          draftCell?.sheet === sheet.name && draftCell.cell === address;
                        const isSelected =
                          focusCell === address || here.some((th) => th.id === selectedThreadId);
                        const isActive =
                          active.column === column && active.row === row && focusCell === null;
                        return (
                          <td
                            key={address}
                            data-cell={address}
                            {...(merge ? { colSpan: merge.colSpan, rowSpan: merge.rowSpan } : {})}
                            className="tm-xlsx__cell"
                            data-numeric={cell?.numeric ? 'true' : undefined}
                            data-selected={isSelected || isDraft ? 'true' : undefined}
                            tabIndex={address === activeAddress ? 0 : -1}
                            aria-selected={isSelected || isActive}
                            onClick={() => {
                              setActive({ column, row });
                              if (here[0]) onSelectThread(here[0].id);
                              else comment(address);
                            }}
                          >
                            {here.length > 0 ? (
                              <span className="tm-xlsx__markers">
                                {here.map((thread) => (
                                  <button
                                    key={thread.id}
                                    type="button"
                                    tabIndex={-1}
                                    className="tm-xlsx__marker"
                                    data-state={
                                      thread.id === selectedThreadId
                                        ? 'selected'
                                        : thread.status === 'resolved'
                                          ? 'resolved'
                                          : 'open'
                                    }
                                    aria-label={t('ViewerFormats.xlsx.marker')
                                      .replace('{number}', String(thread.number))
                                      .replace('{cell}', `${sheet.name}!${address}`)}
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      onSelectThread(thread.id);
                                    }}
                                  >
                                    {thread.number}
                                  </button>
                                ))}
                              </span>
                            ) : null}
                            <span className="tm-xlsx__text">{cell?.text ?? ''}</span>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div
              className="tm-xlsx__tabs"
              role="tablist"
              aria-label={t('ViewerFormats.xlsx.sheets')}
            >
              {visibleSheets.map((candidate) => {
                const count = openBySheet.get(candidate.name) ?? 0;
                const current = candidate.name === sheet.name;
                return (
                  <button
                    key={candidate.name}
                    type="button"
                    role="tab"
                    aria-selected={current}
                    className="tm-xlsx__tab"
                    onClick={() => {
                      setSheetName(candidate.name);
                      setActive({ column: 0, row: 0 });
                    }}
                  >
                    <span dir="auto">{candidate.name}</span>
                    {count > 0 ? (
                      <span
                        className="tm-xlsx__tab-count"
                        aria-label={t('ViewerFormats.openCount').replace('{count}', String(count))}
                      >
                        {count}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          </div>
          {sheet.truncated ? (
            <p className="tm-format-hint">{t('ViewerFormats.xlsx.truncated')}</p>
          ) : null}
          <p className="tm-format-hint">
            {t(onCommentCell ? 'ViewerFormats.xlsx.hint' : 'ViewerFormats.xlsx.hintReadOnly')}
          </p>
          {office && office.sheets.some((entry) => entry.hidden) ? (
            <p className="tm-format-hint">{t('ViewerFormats.xlsx.hiddenSheets')}</p>
          ) : null}
        </>
      )}
    </div>
  );
}

'use client';

import type { ReactNode } from 'react';
import { Button, Checkbox, VisuallyHidden } from '@tmanage/ui';
import { useT } from '../../../lib/i18n/use-t';

export interface PlatformColumn<Row> {
  readonly id: string;
  readonly header: ReactNode;
  readonly cell: (row: Row) => ReactNode;
  /** `mono` for counts and ids. */
  readonly kind?: 'text' | 'mono';
}

export interface PlatformTableProps<Row> {
  /** The table's accessible name. */
  label: string;
  columns: readonly PlatformColumn<Row>[];
  rows: readonly Row[];
  rowKey: (row: Row) => string;
  /** Muted rows: a disabled admin, a suspended organization. */
  isMuted?: (row: Row) => boolean;
  /** Bulk selection: the selected keys and the setter. Omit for no checkboxes. */
  selected?: ReadonlySet<string>;
  onSelectedChange?: (next: ReadonlySet<string>) => void;
  /** Rows that cannot be selected (locked rows). */
  isSelectable?: (row: Row) => boolean;
  /** The bar shown while something is selected — the bulk actions. */
  bulkActions?: (selected: ReadonlySet<string>) => ReactNode;
  /** Keyset paging: another page exists. */
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
  /** A line under the table (the D5 super-admin note). */
  footer?: ReactNode;
}

/**
 * The Platform admin table (Control Center `tm-cc-table` in a flush card): optional row
 * selection with a bulk bar, muted rows, and keyset "Load more" paging (SPEC §5: lists are
 * `?cursor=&limit=`).
 */
export function PlatformTable<Row>({
  label,
  columns,
  rows,
  rowKey,
  isMuted,
  selected,
  onSelectedChange,
  isSelectable,
  bulkActions,
  hasMore = false,
  loadingMore = false,
  onLoadMore,
  footer,
}: PlatformTableProps<Row>) {
  const t = useT();
  const selecting = selected !== undefined && onSelectedChange !== undefined;
  const selectable = rows.filter((row) => (isSelectable ? isSelectable(row) : true));
  const allSelected = selecting && selectable.length > 0 && selected.size === selectable.length;

  function toggle(key: string, on: boolean) {
    if (!selecting) return;
    const next = new Set(selected);
    if (on) next.add(key);
    else next.delete(key);
    onSelectedChange(next);
  }

  return (
    <div className="tm-stack tm-stack--tight">
      {selecting && selected.size > 0 ? (
        <div
          className="tm-cc-card tm-cc-card--quiet tm-cc-hero__actions"
          role="region"
          aria-label={t('PlatformShared.bulkBar')}
        >
          <span className="tm-cc-cell-title">
            {selected.size} {t('PlatformShared.selected')}
          </span>
          {bulkActions ? bulkActions(selected) : null}
          <Button
            type="button"
            tone="text"
            size="compact"
            onClick={() => onSelectedChange(new Set())}
          >
            {t('PlatformShared.clearSelection')}
          </Button>
        </div>
      ) : null}
      <section className="tm-cc-card tm-cc-card--flush" aria-label={label}>
        <table className="tm-table tm-cc-table" aria-label={label}>
          <thead>
            <tr>
              {selecting ? (
                <th scope="col">
                  <Checkbox
                    label={<VisuallyHidden>{t('PlatformShared.selectAll')}</VisuallyHidden>}
                    checked={allSelected}
                    indeterminate={selected.size > 0 && !allSelected}
                    onChange={(event) =>
                      onSelectedChange(
                        event.target.checked
                          ? new Set(selectable.map((row) => rowKey(row)))
                          : new Set(),
                      )
                    }
                  />
                </th>
              ) : null}
              {columns.map((column) => (
                <th key={column.id} scope="col">
                  {column.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const key = rowKey(row);
              const muted = isMuted ? isMuted(row) : false;
              const canSelect = isSelectable ? isSelectable(row) : true;
              return (
                <tr
                  key={key}
                  {...(muted ? { 'data-muted': 'true', style: { opacity: 0.55 } } : {})}
                >
                  {selecting ? (
                    <td>
                      {canSelect ? (
                        <Checkbox
                          label={<VisuallyHidden>{t('PlatformShared.selectRow')}</VisuallyHidden>}
                          checked={selected.has(key)}
                          onChange={(event) => toggle(key, event.target.checked)}
                        />
                      ) : null}
                    </td>
                  ) : null}
                  {columns.map((column) => (
                    <td
                      key={column.id}
                      className={column.kind === 'mono' ? 'tm-cc-cell-mono' : undefined}
                    >
                      {column.cell(row)}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
      {hasMore && onLoadMore ? (
        <div>
          <Button
            type="button"
            tone="outline"
            loading={loadingMore}
            loadingLabel={t('PlatformShared.loading')}
            onClick={onLoadMore}
          >
            {t('PlatformShared.loadMore')}
          </Button>
        </div>
      ) : null}
      {footer ? <InlineFooter>{footer}</InlineFooter> : null}
    </div>
  );
}

function InlineFooter({ children }: { children: ReactNode }) {
  return <p className="tm-cc-card tm-cc-note">{children}</p>;
}

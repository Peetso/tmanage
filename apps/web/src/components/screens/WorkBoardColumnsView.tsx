'use client';

import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Select, Skeleton } from '@tmanage/ui';
import {
  defineBoardColumn,
  listBoardColumns,
  removeBoardColumn,
  WORK_ITEM_STATE_KEYS,
  type BoardColumn,
  type WorkItemStateKey,
} from '../../lib/api/board-columns';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';
import { useDescribeApiError } from '../../lib/api/describe-error';

export interface WorkBoardColumnsViewProps {
  organizationSlug: string;
  api: ApiClient;
}

const STATE_LABELS: Record<WorkItemStateKey, string> = {
  backlog: 'Backlog',
  ready: 'Ready',
  in_progress: 'In progress',
  blocked: 'Blocked',
  internal_review: 'Internal review',
  done: 'Done',
  archived: 'Archived',
};

/**
 * **x308 — an organization's custom work-board columns.** (Work module 7; 38-MODULE-MAP §Work
 * management board views, 22-SCREEN §Work board.)
 *
 * A work-settings admin list: see the columns the board renders, define a new one (a label, the
 * work state it groups, and its slot), and remove one. It is org configuration — the write routes
 * are behind `org.manage` — while listing is any member's. A column is a display grouping over the
 * existing work states, so the state select is drawn from the fixed state-machine keys and nothing
 * here changes the state machine. Every write invalidates the list so it reflects the server.
 */
export function WorkBoardColumnsView({ organizationSlug, api }: WorkBoardColumnsViewProps) {
  const describe = useDescribeApiError();
  const t = useT();
  const queries = useQueryClient();
  const queryKey = ['work-board-columns', organizationSlug] as const;
  const [label, setLabel] = useState('');
  const [stateKey, setStateKey] = useState<WorkItemStateKey>('backlog');
  const [position, setPosition] = useState('0');
  const [failure, setFailure] = useState<string | undefined>(undefined);

  const columns = useQuery({
    queryKey,
    queryFn: () => listBoardColumns(api, organizationSlug),
  });

  function refresh() {
    void queries.invalidateQueries({ queryKey });
  }

  const save = useMutation({
    mutationFn: (input: { label: string; stateKey: WorkItemStateKey; position: number }) =>
      defineBoardColumn(api, organizationSlug, input),
    onSuccess: () => {
      setFailure(undefined);
      setLabel('');
      setPosition('0');
      refresh();
    },
    onError: (error) => setFailure(describe(error)),
  });

  const drop = useMutation({
    mutationFn: (columnId: string) => removeBoardColumn(api, organizationSlug, columnId),
    onSuccess: () => {
      setFailure(undefined);
      refresh();
    },
    onError: (error) => setFailure(describe(error)),
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const slot = Number(position);
    if (label.trim() === '') {
      setFailure(t('WorkBoardColumnsView.needLabel'));
      return;
    }
    if (!Number.isInteger(slot) || slot < 0) {
      setFailure(t('WorkBoardColumnsView.needPosition'));
      return;
    }
    save.mutate({ label: label.trim(), stateKey, position: slot });
  }

  const items: readonly BoardColumn[] = columns.data ?? [];
  const pending = save.isPending || drop.isPending;

  return (
    <section className="tm-panel tm-stack" aria-labelledby="tm-board-columns">
      <h2 id="tm-board-columns" className="tm-eyebrow">
        {t('WorkBoardColumnsView.heading')}
      </h2>

      {failure ? (
        <InlineAlert tone="danger" title={t('WorkBoardColumnsView.failureTitle')} live>
          {failure}
        </InlineAlert>
      ) : null}

      <form className="tm-stack" onSubmit={submit} aria-label={t('WorkBoardColumnsView.formLabel')}>
        <Field
          label={t('WorkBoardColumnsView.label')}
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          maxLength={120}
        />
        <Select
          label={t('WorkBoardColumnsView.groupsState')}
          name="board-column-state"
          value={stateKey}
          onChange={(event) => setStateKey(event.target.value as WorkItemStateKey)}
        >
          {WORK_ITEM_STATE_KEYS.map((key) => (
            <option key={key} value={key}>
              {STATE_LABELS[key]}
            </option>
          ))}
        </Select>
        <Field
          label={t('WorkBoardColumnsView.position')}
          type="number"
          value={position}
          onChange={(event) => setPosition(event.target.value)}
        />
        <div className="tm-row">
          <Button
            type="submit"
            tone="ink"
            size="accessible"
            disabled={pending}
            loading={save.isPending}
            loadingLabel={t('WorkBoardColumnsView.adding')}
          >
            {t('WorkBoardColumnsView.addColumn')}
          </Button>
        </div>
      </form>

      <h3 className="tm-eyebrow">{t('WorkBoardColumnsView.rendered')}</h3>

      {columns.isPending ? (
        <LoadingRegion label={t('WorkBoardColumnsView.loading')}>
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {columns.isError ? (
        <InlineAlert tone="danger" title={t('WorkBoardColumnsView.loadError')} live>
          {describe(columns.error)}
        </InlineAlert>
      ) : null}

      {columns.data ? (
        items.length === 0 ? (
          <p className="tm-prose">{t('WorkBoardColumnsView.empty')}</p>
        ) : (
          <ul className="tm-list" aria-label={t('WorkBoardColumnsView.listLabel')}>
            {items.map((column) => (
              <li key={column.id} className="tm-row">
                <span className="tm-prose">
                  {column.position}. {column.label}
                </span>
                <span className="tm-eyebrow">
                  {STATE_LABELS[column.stateKey as WorkItemStateKey] ?? column.stateKey}
                </span>
                <Button
                  type="button"
                  tone="outline"
                  size="accessible"
                  disabled={pending}
                  onClick={() => drop.mutate(column.id)}
                >
                  {t('WorkBoardColumnsView.remove')}
                </Button>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </section>
  );
}

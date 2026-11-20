'use client';

import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { WORK_ITEM_TITLE_MAX } from '@tmanage/domain';
import { Button, Checkbox, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import {
  addSubtask,
  deleteSubtask,
  listSubtasks,
  updateSubtask,
  type WorkSubtask,
} from '../../lib/api/work-items';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';
import { useDescribeApiError } from '../../lib/api/describe-error';

export interface WorkSubtasksViewProps {
  organizationSlug: string;
  workItemId: string;
  api: ApiClient;
}

/**
 * **x307 — a work item's ordered subtasks / breakdown.** (Work module; the work-item detail
 * screen's breakdown section.)
 *
 * A member breaks a work item into ordered child rows: add a titled subtask, see them in order,
 * toggle each done, delete one, and read a progress bar off the server's `{ done, total }` roll-up.
 * There is no state machine on the parent — the bar is a count.
 *
 * It is mounted additively beside the rest of the detail screen and reads its own query, so it
 * neither depends on nor changes the work item's own read. Every write invalidates that query so
 * the list reflects the server rather than an optimistic guess.
 */
export function WorkSubtasksView({ organizationSlug, workItemId, api }: WorkSubtasksViewProps) {
  const describe = useDescribeApiError();
  const t = useT();
  const queries = useQueryClient();
  const queryKey = ['work-item-subtasks', organizationSlug, workItemId] as const;
  const [title, setTitle] = useState('');
  const [failure, setFailure] = useState<string | undefined>(undefined);

  const subtasks = useQuery({
    queryKey,
    queryFn: () => listSubtasks(api, organizationSlug, workItemId),
  });

  function refresh() {
    void queries.invalidateQueries({ queryKey });
  }

  const add = useMutation({
    mutationFn: (nextTitle: string) =>
      addSubtask(api, organizationSlug, workItemId, { title: nextTitle }),
    onSuccess: () => {
      setTitle('');
      setFailure(undefined);
      refresh();
    },
    onError: (error) => setFailure(describe(error)),
  });

  const toggle = useMutation({
    mutationFn: (item: WorkSubtask) =>
      updateSubtask(api, organizationSlug, workItemId, item.id, { done: !item.done }),
    onSuccess: () => {
      setFailure(undefined);
      refresh();
    },
    onError: (error) => setFailure(describe(error)),
  });

  const remove = useMutation({
    mutationFn: (item: WorkSubtask) => deleteSubtask(api, organizationSlug, workItemId, item.id),
    onSuccess: () => {
      setFailure(undefined);
      refresh();
    },
    onError: (error) => setFailure(describe(error)),
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = title.trim();
    if (trimmed === '') return;
    add.mutate(trimmed);
  }

  const list = subtasks.data;
  const items = list?.items ?? [];
  const busy = toggle.isPending || remove.isPending;

  return (
    <section className="tm-panel tm-stack" aria-labelledby="tm-work-subtasks">
      <h2 id="tm-work-subtasks" className="tm-eyebrow">
        {t('WorkSubtasksView.heading')}
      </h2>

      {subtasks.isPending ? (
        <LoadingRegion label={t('WorkSubtasksView.loading')}>
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {subtasks.isError ? (
        <InlineAlert tone="danger" title={t('WorkSubtasksView.loadError')} live>
          {describe(subtasks.error)}
        </InlineAlert>
      ) : null}

      {failure ? (
        <InlineAlert tone="danger" title={t('WorkSubtasksView.failureTitle')} live>
          {failure}
        </InlineAlert>
      ) : null}

      {list ? (
        items.length === 0 ? (
          <p className="tm-prose">{t('WorkSubtasksView.empty')}</p>
        ) : (
          <>
            <p className="tm-prose">
              {list.done} {t('WorkSubtasksView.progressOf')} {list.total}{' '}
              {t('WorkSubtasksView.progressDone')}
            </p>
            <progress
              className="tm-progress"
              max={list.total}
              value={list.done}
              aria-label={`${list.done} ${t('WorkSubtasksView.progressOf')} ${list.total} ${t('WorkSubtasksView.subtasksDone')}`}
            />
            <ul className="tm-list" aria-label={t('WorkSubtasksView.listLabel')}>
              {items.map((item) => (
                <li key={item.id} className="tm-row">
                  <Checkbox
                    label={item.title}
                    checked={item.done}
                    disabled={busy}
                    onChange={() => toggle.mutate(item)}
                  />
                  <Button
                    type="button"
                    tone="text"
                    size="accessible"
                    disabled={busy}
                    onClick={() => remove.mutate(item)}
                  >
                    {t('WorkSubtasksView.remove')}
                  </Button>
                </li>
              ))}
            </ul>
          </>
        )
      ) : null}

      <form className="tm-stack" noValidate onSubmit={submit}>
        <Field
          label={t('WorkSubtasksView.addLabel')}
          name="subtaskTitle"
          value={title}
          maxLength={WORK_ITEM_TITLE_MAX}
          onChange={(event) => setTitle(event.target.value)}
          hint={t('WorkSubtasksView.addHint')}
        />
        <div className="tm-row">
          <Button
            type="submit"
            tone="ink"
            size="accessible"
            loading={add.isPending}
            loadingLabel={t('WorkSubtasksView.adding')}
            disabled={title.trim() === ''}
          >
            {t('WorkSubtasksView.addSubtask')}
          </Button>
        </div>
      </form>
    </section>
  );
}

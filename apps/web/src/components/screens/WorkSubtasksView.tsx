'use client';

import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Checkbox, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import {
  addSubtask,
  deleteSubtask,
  listSubtasks,
  updateSubtask,
  type WorkSubtask,
} from '../../lib/api/work-items';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface WorkSubtasksViewProps {
  organizationSlug: string;
  workItemId: string;
  api: ApiClient;
}

function describe(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
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
        Subtasks
      </h2>

      {subtasks.isPending ? (
        <LoadingRegion label="Loading this item’s subtasks.">
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {subtasks.isError ? (
        <InlineAlert tone="danger" title="Could not load the subtasks" live>
          {describe(subtasks.error)}
        </InlineAlert>
      ) : null}

      {failure ? (
        <InlineAlert tone="danger" title="That did not go through" live>
          {failure}
        </InlineAlert>
      ) : null}

      {list ? (
        items.length === 0 ? (
          <p className="tm-prose">No subtasks yet. Add the first one below.</p>
        ) : (
          <>
            <p className="tm-prose">
              {list.done} of {list.total} done.
            </p>
            <progress
              className="tm-progress"
              max={list.total}
              value={list.done}
              aria-label={`${list.done} of ${list.total} subtasks done`}
            />
            <ul className="tm-list" aria-label="Subtasks">
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
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          </>
        )
      ) : null}

      <form className="tm-stack" noValidate onSubmit={submit}>
        <Field
          label="Add a subtask"
          name="subtaskTitle"
          value={title}
          maxLength={300}
          onChange={(event) => setTitle(event.target.value)}
          hint="A short child task. It is added to the end of the list."
        />
        <div className="tm-row">
          <Button
            type="submit"
            tone="ink"
            size="accessible"
            loading={add.isPending}
            loadingLabel="Adding"
            disabled={title.trim() === ''}
          >
            Add subtask
          </Button>
        </div>
      </form>
    </section>
  );
}

'use client';

import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Checkbox, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import {
  addChecklistItem,
  listChecklist,
  updateChecklistItem,
  type WorkChecklistItem,
} from '../../lib/api/work-items';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface WorkChecklistPanelProps {
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
 * **x145 — a work item's checklist / sub-items.** (Work module 7; TM-13's "checklist" section.)
 *
 * The smallest useful unit of the sub-items the work-item detail screen named but had not built:
 * add a labelled item, see the list in order, toggle each one done. Reorder-by-drag and a
 * per-item assignee are NS-13; this panel does add / list / toggle and says plainly how many are
 * done.
 *
 * It is mounted additively beside the rest of the detail screen and reads its own query, so it
 * neither depends on nor changes the work item's own read. Every write invalidates that query so
 * the list reflects the server rather than an optimistic guess.
 */
export function WorkChecklistPanel({ organizationSlug, workItemId, api }: WorkChecklistPanelProps) {
  const queries = useQueryClient();
  const queryKey = ['work-item-checklist', organizationSlug, workItemId] as const;
  const [label, setLabel] = useState('');
  const [failure, setFailure] = useState<string | undefined>(undefined);

  const checklist = useQuery({
    queryKey,
    queryFn: () => listChecklist(api, organizationSlug, workItemId),
  });

  function refresh() {
    void queries.invalidateQueries({ queryKey });
  }

  const add = useMutation({
    mutationFn: (nextLabel: string) =>
      addChecklistItem(api, organizationSlug, workItemId, { label: nextLabel }),
    onSuccess: () => {
      setLabel('');
      setFailure(undefined);
      refresh();
    },
    onError: (error) => setFailure(describe(error)),
  });

  const toggle = useMutation({
    mutationFn: (item: WorkChecklistItem) =>
      updateChecklistItem(api, organizationSlug, workItemId, item.id, { done: !item.done }),
    onSuccess: () => {
      setFailure(undefined);
      refresh();
    },
    onError: (error) => setFailure(describe(error)),
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = label.trim();
    if (trimmed === '') return;
    add.mutate(trimmed);
  }

  const items = checklist.data ?? [];
  const doneCount = items.filter((item) => item.done).length;

  return (
    <section className="tm-panel tm-stack" aria-labelledby="tm-work-checklist">
      <h2 id="tm-work-checklist" className="tm-eyebrow">
        Checklist
      </h2>

      {checklist.isPending ? (
        <LoadingRegion label="Loading this item’s checklist.">
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {checklist.isError ? (
        <InlineAlert tone="danger" title="Could not load the checklist" live>
          {describe(checklist.error)}
        </InlineAlert>
      ) : null}

      {failure ? (
        <InlineAlert tone="danger" title="That did not go through" live>
          {failure}
        </InlineAlert>
      ) : null}

      {checklist.data ? (
        items.length === 0 ? (
          <p className="tm-prose">No sub-items yet. Add the first one below.</p>
        ) : (
          <>
            <p className="tm-prose">
              {doneCount} of {items.length} done.
            </p>
            <ul className="tm-list" aria-label="Checklist items">
              {items.map((item) => (
                <li key={item.id}>
                  <Checkbox
                    label={item.label}
                    checked={item.done}
                    disabled={toggle.isPending}
                    onChange={() => toggle.mutate(item)}
                  />
                </li>
              ))}
            </ul>
          </>
        )
      ) : null}

      <form className="tm-stack" noValidate onSubmit={submit}>
        <Field
          label="Add a checklist item"
          name="checklistLabel"
          value={label}
          maxLength={300}
          onChange={(event) => setLabel(event.target.value)}
          hint="A short sub-task. It is added to the end of the list."
        />
        <div className="tm-row">
          <Button
            type="submit"
            tone="ink"
            size="accessible"
            loading={add.isPending}
            loadingLabel="Adding"
            disabled={label.trim() === ''}
          >
            Add sub-item
          </Button>
        </div>
      </form>
    </section>
  );
}

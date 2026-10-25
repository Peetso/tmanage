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
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';
import { useDescribeApiError } from '../../lib/api/describe-error';

export interface WorkChecklistPanelProps {
  organizationSlug: string;
  workItemId: string;
  api: ApiClient;
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
  const describe = useDescribeApiError();
  const t = useT();
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
        {t('WorkChecklistPanel.heading')}
      </h2>

      {checklist.isPending ? (
        <LoadingRegion label={t('WorkChecklistPanel.loading')}>
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {checklist.isError ? (
        <InlineAlert tone="danger" title={t('WorkChecklistPanel.loadError')} live>
          {describe(checklist.error)}
        </InlineAlert>
      ) : null}

      {failure ? (
        <InlineAlert tone="danger" title={t('WorkChecklistPanel.submitError')} live>
          {failure}
        </InlineAlert>
      ) : null}

      {checklist.data ? (
        items.length === 0 ? (
          <p className="tm-prose">{t('WorkChecklistPanel.empty')}</p>
        ) : (
          <>
            <p className="tm-prose">
              {doneCount} {t('WorkChecklistPanel.ofCount')} {items.length}{' '}
              {t('WorkChecklistPanel.done')}
            </p>
            <ul className="tm-list" aria-label={t('WorkChecklistPanel.listLabel')}>
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
          label={t('WorkChecklistPanel.addLabel')}
          name="checklistLabel"
          value={label}
          maxLength={300}
          onChange={(event) => setLabel(event.target.value)}
          hint={t('WorkChecklistPanel.addHint')}
        />
        <div className="tm-row">
          <Button
            type="submit"
            tone="ink"
            size="accessible"
            loading={add.isPending}
            loadingLabel={t('WorkChecklistPanel.adding')}
            disabled={label.trim() === ''}
          >
            {t('WorkChecklistPanel.addSubItem')}
          </Button>
        </div>
      </form>
    </section>
  );
}

'use client';

import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import {
  clearWorkItemReminder,
  listDueReminders,
  setWorkItemReminder,
  type DueReminder,
} from '../../lib/api/work-items';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';
import { useDescribeApiError } from '../../lib/api/describe-error';
import { appLocale } from '../../lib/i18n/app-locale';

export interface WorkItemReminderViewProps {
  organizationSlug: string;
  workItemId: string;
  api: ApiClient;
}

function formatWhen(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return at.toLocaleString(appLocale());
}

/**
 * **x256 — a personal reminder on a work item.** (Work module 7; 11-USER-STORIES / module map
 * §Work "due/approval reminders follow policy".)
 *
 * The smallest useful unit of the reminder: set a `remindAt` on this item for yourself, clear it,
 * and see your own reminders that are due. Behind `work.read` — anyone who may read the item may
 * remind themselves about it. **No email is dispatched here**; dispatch is a separate, out-of-scope
 * path, so this is storage only — the list is a personal, on-screen due view.
 *
 * It is mounted additively beside the rest of the detail screen (disjoint from the watchers,
 * checklist and comments panels), reads its own due query, and invalidates it on every write so
 * the list reflects the server. Setting a reminder is an idempotent upsert — a repeat moves it.
 */
export function WorkItemReminderView({
  organizationSlug,
  workItemId,
  api,
}: WorkItemReminderViewProps) {
  const describe = useDescribeApiError();
  const t = useT();
  const queries = useQueryClient();
  const queryKey = ['work-item-reminders-due', organizationSlug] as const;
  const [remindAt, setRemindAt] = useState('');
  const [failure, setFailure] = useState<string | undefined>(undefined);

  const due = useQuery({
    queryKey,
    queryFn: () => listDueReminders(api, organizationSlug),
  });

  function refresh() {
    void queries.invalidateQueries({ queryKey });
  }

  const save = useMutation({
    mutationFn: (isoInstant: string) =>
      setWorkItemReminder(api, organizationSlug, workItemId, isoInstant),
    onSuccess: () => {
      setFailure(undefined);
      setRemindAt('');
      refresh();
    },
    onError: (error) => setFailure(describe(error)),
  });

  const clear = useMutation({
    mutationFn: () => clearWorkItemReminder(api, organizationSlug, workItemId),
    onSuccess: () => {
      setFailure(undefined);
      refresh();
    },
    onError: (error) => setFailure(describe(error)),
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const at = new Date(remindAt);
    if (remindAt === '' || Number.isNaN(at.getTime())) {
      setFailure(t('WorkItemReminderView.invalidWhen'));
      return;
    }
    save.mutate(at.toISOString());
  }

  const items: readonly DueReminder[] = due.data ?? [];
  const pending = save.isPending || clear.isPending;

  return (
    <section className="tm-panel tm-stack" aria-labelledby="tm-work-reminder">
      <h2 id="tm-work-reminder" className="tm-eyebrow">
        {t('WorkItemReminderView.reminder')}
      </h2>

      {failure ? (
        <InlineAlert tone="danger" title={t('WorkItemReminderView.failureTitle')} live>
          {failure}
        </InlineAlert>
      ) : null}

      <form className="tm-stack" onSubmit={submit}>
        <Field
          label={t('WorkItemReminderView.remindMeAt')}
          type="datetime-local"
          value={remindAt}
          onChange={(event) => setRemindAt(event.target.value)}
        />
        <div className="tm-row">
          <Button
            type="submit"
            tone="ink"
            size="accessible"
            disabled={pending}
            loading={save.isPending}
            loadingLabel={t('WorkItemReminderView.saving')}
          >
            {t('WorkItemReminderView.setReminder')}
          </Button>
          <Button
            type="button"
            tone="outline"
            size="accessible"
            disabled={pending}
            loading={clear.isPending}
            loadingLabel={t('WorkItemReminderView.clearing')}
            onClick={() => clear.mutate()}
          >
            {t('WorkItemReminderView.clearReminder')}
          </Button>
        </div>
      </form>

      <h3 className="tm-eyebrow">{t('WorkItemReminderView.myRemindersDue')}</h3>

      {due.isPending ? (
        <LoadingRegion label={t('WorkItemReminderView.loadingDue')}>
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {due.isError ? (
        <InlineAlert tone="danger" title={t('WorkItemReminderView.loadError')} live>
          {describe(due.error)}
        </InlineAlert>
      ) : null}

      {due.data ? (
        items.length === 0 ? (
          <p className="tm-prose">{t('WorkItemReminderView.nothingDue')}</p>
        ) : (
          <ul className="tm-list" aria-label={t('WorkItemReminderView.remindersDueList')}>
            {items.map((reminder) => (
              <li key={reminder.id} className="tm-stack">
                <p className="tm-prose">{reminder.workItemTitle}</p>
                <time className="tm-eyebrow" dateTime={reminder.remindAt}>
                  {formatWhen(reminder.remindAt)}
                </time>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </section>
  );
}

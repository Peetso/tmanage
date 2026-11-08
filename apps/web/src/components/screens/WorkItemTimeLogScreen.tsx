'use client';

import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import Link from 'next/link';
import { AppShell } from '../shell/AppShell';
import './work-core.css';
import { browserApiClient } from '../../lib/api/browser-client';
import { deleteTimeLog, listTimeLogs, type TimeLog } from '../../lib/api/work-items';
import { addTimeLogOrQueue } from '../../lib/offline/write-or-queue';
import { usePendingWrites } from '../../lib/offline/use-offline';
import { PendingBadge } from '../pwa/PendingBadge';
import { OFFLINE_LINES, useDescribeApiError } from '../../lib/api/describe-error';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';

export interface WorkItemTimeLogScreenProps {
  organizationSlug: string;
  organizationName: string;
  workItemId: string;
  client?: ApiClient;
}

/** One day of effort, in minutes; the API bounds the same range and answers 400 beyond it. */
const MAX_MINUTES = 24 * 60;

/**
 * **Work item time tracking (module 7, x231).**
 *
 * `38-MODULE-MAP` §Work — the audit's "Work built; no time/effort logging". Logged effort for one
 * work item: a person records minutes spent on a calendar day with an optional note, the screen
 * lists the entries newest day first and shows a summed total, and the author may remove an entry
 * they logged. There is no per-entry edit — the API grants log/list/delete-own only this slice.
 */
export function WorkItemTimeLogScreen({
  organizationSlug,
  organizationName,
  workItemId,
  client,
}: WorkItemTimeLogScreenProps) {
  const describeError = useDescribeApiError(OFFLINE_LINES);
  const t = useT();
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();

  const logs = useQuery({
    queryKey: ['work-item-time-logs', organizationSlug, workItemId],
    queryFn: () => listTimeLogs(api, organizationSlug, workItemId),
  });

  const [minutes, setMinutes] = useState('');
  const [spentOn, setSpentOn] = useState('');
  const [note, setNote] = useState('');

  const parsedMinutes = Number(minutes);
  const minutesValid =
    minutes.trim() !== '' &&
    Number.isInteger(parsedMinutes) &&
    parsedMinutes > 0 &&
    parsedMinutes <= MAX_MINUTES;
  const spentOnValid = /^\d{4}-\d{2}-\d{2}$/.test(spentOn);

  const add = useMutation({
    // 53-16: offline the entry is queued (Pending badge) and sent when the connection is back.
    mutationFn: () =>
      addTimeLogOrQueue(api, organizationSlug, workItemId, {
        minutes: parsedMinutes,
        spentOn,
        note: note.trim() === '' ? null : note.trim(),
      }),
    onSuccess: async () => {
      setMinutes('');
      setSpentOn('');
      setNote('');
      await queryClient.invalidateQueries({
        queryKey: ['work-item-time-logs', organizationSlug, workItemId],
      });
    },
  });

  const remove = useMutation({
    mutationFn: (entryId: string) => deleteTimeLog(api, organizationSlug, workItemId, entryId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ['work-item-time-logs', organizationSlug, workItemId],
      });
    },
  });

  const entries = logs.data?.entries ?? [];
  const pendingEntries = usePendingWrites(organizationSlug, workItemId, 'time-log');
  const totalMinutes = logs.data?.totalMinutes ?? 0;
  const canAdd = minutesValid && spentOnValid && !add.isPending;

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="work"
      eyebrow={t('WorkItemTimeLogScreen.eyebrow')}
      title={t('WorkItemTimeLogScreen.title')}
      description={t('WorkItemTimeLogScreen.description')}
    >
      <div className="tm-wk-page tm-stack">
        <nav className="tm-segmented tm-wk-subnav" aria-label={t('WorkItemTimeLogScreen.subnav')}>
          <Link href={`/${organizationSlug}/work/${workItemId}`}>
            {t('WorkItemTimeLogScreen.overview')}
          </Link>
          <Link href={`/${organizationSlug}/work/${workItemId}/activity`}>
            {t('WorkItemTimeLogScreen.activity')}
          </Link>
          <Link href={`/${organizationSlug}/work/${workItemId}/time-logs`} aria-current="page">
            {t('WorkItemTimeLogScreen.time')}
          </Link>
          <Link href={`/${organizationSlug}/work/${workItemId}/estimate`}>
            {t('WorkItemTimeLogScreen.estimate')}
          </Link>
        </nav>
        <section className="tm-panel tm-stack" aria-labelledby="tm-time-new-heading">
          <h2 id="tm-time-new-heading" className="tm-eyebrow">
            {t('WorkItemTimeLogScreen.logTimeHeading')}
          </h2>
          <form
            className="tm-stack"
            noValidate
            onSubmit={(event: FormEvent<HTMLFormElement>) => {
              event.preventDefault();
              if (canAdd) add.mutate();
            }}
          >
            <Field
              label={t('WorkItemTimeLogScreen.minutesLabel')}
              name="minutes"
              type="number"
              min={1}
              max={MAX_MINUTES}
              value={minutes}
              onChange={(event) => setMinutes(event.target.value)}
              hint={`${t('WorkItemTimeLogScreen.minutesHint')} ${MAX_MINUTES}.`}
              required
            />
            <Field
              label={t('WorkItemTimeLogScreen.dayLabel')}
              name="spentOn"
              type="date"
              value={spentOn}
              onChange={(event) => setSpentOn(event.target.value)}
              hint={t('WorkItemTimeLogScreen.dayHint')}
              required
            />
            <Field
              label={t('WorkItemTimeLogScreen.noteLabel')}
              name="note"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              hint={t('WorkItemTimeLogScreen.noteHint')}
            />
            {add.isError ? (
              <InlineAlert tone="danger" title={t('WorkItemTimeLogScreen.logError')} live>
                {describeError(add.error)}
              </InlineAlert>
            ) : null}
            <div className="tm-row">
              <Button type="submit" tone="ink" disabled={!canAdd} loading={add.isPending}>
                {t('WorkItemTimeLogScreen.logTime')}
              </Button>
            </div>
          </form>
        </section>

        <section className="tm-panel tm-stack" aria-labelledby="tm-time-list-heading">
          <div className="tm-row tm-row--between">
            <h2 id="tm-time-list-heading" className="tm-eyebrow">
              {t('WorkItemTimeLogScreen.loggedEffort')}
            </h2>
            <span className="tm-badge" aria-label={t('WorkItemTimeLogScreen.totalAria')}>
              {formatMinutes(totalMinutes)} {t('WorkItemTimeLogScreen.total')}
            </span>
          </div>

          {logs.isError ? (
            <InlineAlert tone="danger" title={t('WorkItemTimeLogScreen.loadError')} live>
              {describeError(logs.error)}
            </InlineAlert>
          ) : null}

          {logs.isPending ? (
            <LoadingRegion label={t('WorkItemTimeLogScreen.loading')}>
              <Skeleton height="var(--row)" />
              <Skeleton height="var(--row)" />
            </LoadingRegion>
          ) : null}

          {!logs.isPending && !logs.isError && entries.length === 0 ? (
            <InlineAlert tone="neutral" title={t('WorkItemTimeLogScreen.emptyTitle')}>
              {t('WorkItemTimeLogScreen.emptyBody')}
            </InlineAlert>
          ) : null}

          {!logs.isPending && !logs.isError && entries.length > 0 ? (
            <ul className="tm-stack tm-list">
              {entries.map((entry: TimeLog) => (
                <li key={entry.id} className="tm-row tm-row--between tm-list__item">
                  <span>
                    <strong>{formatMinutes(entry.minutes)}</strong> {t('WorkItemTimeLogScreen.on')}{' '}
                    {entry.spentOn}
                    {entry.note ? ` — ${entry.note}` : ''}
                  </span>
                  <Button
                    tone="destructive"
                    onClick={() => remove.mutate(entry.id)}
                    disabled={remove.isPending}
                    aria-label={`${t('WorkItemTimeLogScreen.deletePrefix')} ${formatMinutes(entry.minutes)} ${t('WorkItemTimeLogScreen.entryOn')} ${entry.spentOn}`}
                  >
                    {t('WorkItemTimeLogScreen.delete')}
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}

          {pendingEntries.length > 0 ? (
            <ul className="tm-stack tm-list">
              {pendingEntries.map((write) => (
                <li key={write.id} className="tm-pending-row tm-list__item">
                  <span>
                    <strong>{formatMinutes(write.payload.minutes)}</strong>{' '}
                    {t('WorkItemTimeLogScreen.on')} {write.payload.spentOn}
                    {write.payload.note ? ` — ${write.payload.note}` : ''}
                  </span>
                  <PendingBadge conflict={write.status === 'conflict'} />
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      </div>
    </AppShell>
  );
}

function formatMinutes(total: number): string {
  const hours = Math.floor(total / 60);
  const mins = total % 60;
  if (hours === 0) return `${mins}m`;
  if (mins === 0) return `${hours}h`;
  return `${hours}h ${mins}m`;
}

'use client';

import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { addTimeLog, deleteTimeLog, listTimeLogs, type TimeLog } from '../../lib/api/work-items';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

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
    mutationFn: () =>
      addTimeLog(api, organizationSlug, workItemId, {
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
  const totalMinutes = logs.data?.totalMinutes ?? 0;
  const canAdd = minutesValid && spentOnValid && !add.isPending;

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="work"
      title="Time tracking"
      description="Log the effort spent on this work item and see the running total."
    >
      <section className="tm-panel tm-stack" aria-labelledby="tm-time-new-heading">
        <h2 id="tm-time-new-heading" className="tm-eyebrow">
          Log time
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
            label="Minutes"
            name="minutes"
            type="number"
            min={1}
            max={MAX_MINUTES}
            value={minutes}
            onChange={(event) => setMinutes(event.target.value)}
            hint={`A whole number of minutes, 1 to ${MAX_MINUTES}.`}
            required
          />
          <Field
            label="Day"
            name="spentOn"
            type="date"
            value={spentOn}
            onChange={(event) => setSpentOn(event.target.value)}
            hint="The calendar day the effort was spent."
            required
          />
          <Field
            label="Note"
            name="note"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            hint="Optional — what the time was spent on."
          />
          {add.isError ? (
            <InlineAlert tone="danger" title="Could not log the time" live>
              {describeError(add.error)}
            </InlineAlert>
          ) : null}
          <div className="tm-row">
            <Button type="submit" tone="ink" disabled={!canAdd} loading={add.isPending}>
              Log time
            </Button>
          </div>
        </form>
      </section>

      <section className="tm-panel tm-stack" aria-labelledby="tm-time-list-heading">
        <div className="tm-row tm-row--between">
          <h2 id="tm-time-list-heading" className="tm-eyebrow">
            Logged effort
          </h2>
          <span className="tm-badge" aria-label="Total time logged">
            {formatMinutes(totalMinutes)} total
          </span>
        </div>

        {logs.isError ? (
          <InlineAlert tone="danger" title="Could not load the time logs" live>
            {describeError(logs.error)}
          </InlineAlert>
        ) : null}

        {logs.isPending ? (
          <LoadingRegion label="Loading the time logs.">
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {!logs.isPending && !logs.isError && entries.length === 0 ? (
          <InlineAlert tone="neutral" title="No time logged yet">
            Record the first entry above.
          </InlineAlert>
        ) : null}

        {!logs.isPending && !logs.isError && entries.length > 0 ? (
          <ul className="tm-stack tm-list">
            {entries.map((entry: TimeLog) => (
              <li key={entry.id} className="tm-row tm-row--between tm-list__item">
                <span>
                  <strong>{formatMinutes(entry.minutes)}</strong> on {entry.spentOn}
                  {entry.note ? ` — ${entry.note}` : ''}
                </span>
                <Button
                  tone="destructive"
                  onClick={() => remove.mutate(entry.id)}
                  disabled={remove.isPending}
                  aria-label={`Delete the ${formatMinutes(entry.minutes)} entry on ${entry.spentOn}`}
                >
                  Delete
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
      </section>
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

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The network dropped. Try again.';
  return 'Something went wrong.';
}

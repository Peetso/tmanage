'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Field, InlineAlert, Select } from '@tmanage/ui';
import type { ApiClient } from '../../lib/api/client';
import { describeApiErrorNow } from '../../lib/api/describe-error';
import {
  deleteUnassignedEntries,
  moveTimesheetEntries,
  splitTimesheetEntry,
  type Timesheet,
  type TimesheetEntry,
} from '../../lib/api/finance-core';
import { listWorkItems, MAX_WORK_ITEM_PAGE } from '../../lib/api/work-items';
import { formatDuration } from '../../lib/i18n/duration';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import { useDisplayFormatters } from '../../lib/i18n/use-formatters';
import { useTOr } from '../../lib/i18n/use-t-or';

type TOr = ReturnType<typeof useTOr>;

interface Unassigned {
  readonly entry: TimesheetEntry;
  /** The project the entry is already on, if any; a task must then be in that project. */
  readonly projectId: string | null;
}

/**
 * Live check B2 / item 2 — the unassigned time of the week, with real actions: put it on a task
 * (only tasks the person can see; part of it, or all), or delete it. Only while the week can be
 * edited; the API refuses locked, approved or filed entries again on every call.
 */
export function UnassignedTimeList({
  api,
  organizationSlug,
  sheet,
}: {
  api: ApiClient;
  organizationSlug: string;
  sheet: Timesheet;
}) {
  const tr = useTOr();
  const locale = useActiveLocale();
  const format = useDisplayFormatters();
  const [assigning, setAssigning] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const editable = (sheet.state === 'open' || sheet.state === 'changes_requested') && !sheet.locked;
  const rows: readonly Unassigned[] = sheet.groups
    .filter((group) => group.workItemId === null)
    .flatMap((group) => group.entries.map((entry) => ({ entry, projectId: group.projectId })));

  const queryClient = useQueryClient();
  // UX test T-P2-1 / bug 6: show the new totals at once, then re-read every summary of the week.
  const refresh = async (view: Timesheet) => {
    setAssigning(null);
    setDeleting(null);
    queryClient.setQueriesData<Timesheet>(
      { queryKey: ['finance-timesheet-mine', organizationSlug] },
      (old) => (old?.id === view.id ? view : old),
    );
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['finance-timesheet-mine', organizationSlug] }),
      queryClient.invalidateQueries({ queryKey: ['finance-timesheet-team', organizationSlug] }),
    ]);
  };
  const remove = useMutation({
    mutationFn: (entryId: string) =>
      deleteUnassignedEntries(api, organizationSlug, sheet.id, [entryId]),
    onSuccess: refresh,
  });

  if (rows.length === 0) return null;
  return (
    <section className="tm-stack" aria-labelledby="tm-ts-unassigned">
      <h3 id="tm-ts-unassigned" className="tm-eyebrow">
        {tr('Time.unassigned', 'Unassigned time')}
      </h3>
      <p className="tm-field__hint">
        {editable
          ? tr(
              'UnassignedTime.intro',
              'Time with no task chosen. Put it on a task, all of it or part of it, or delete what you do not want kept.',
            )
          : tr(
              'UnassignedTime.readOnly',
              'This week cannot be changed now, so its unassigned time stays as it is.',
            )}
      </p>
      <div className="tm-table-scroll">
        <table className="tm-table" aria-label={tr('Time.unassigned', 'Unassigned time')}>
          <thead>
            <tr>
              <th scope="col">{tr('UnassignedTime.day', 'Day')}</th>
              <th scope="col">{tr('UnassignedTime.time', 'Time')}</th>
              <th scope="col">{tr('UnassignedTime.how', 'How')}</th>
              {editable ? (
                <th scope="col">
                  <span className="tm-visually-hidden">
                    {tr('UnassignedTime.actions', 'Actions')}
                  </span>
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {rows.map(({ entry, projectId }) => (
              <tr key={entry.id}>
                <td>{format.day(entry.spentOn)}</td>
                <td>{formatDuration(entry.minutes, locale)}</td>
                <td>
                  <SourceMark source={entry.source} tr={tr} />
                </td>
                {editable ? (
                  <td>
                    <div className="tm-row tm-row--wrap">
                      <Button
                        size="compact"
                        tone="outline"
                        aria-expanded={assigning === entry.id}
                        onClick={() => setAssigning(assigning === entry.id ? null : entry.id)}
                      >
                        {tr('UnassignedTime.assign', 'Put on a task')}
                      </Button>
                      <Button size="compact" tone="text" onClick={() => setDeleting(entry.id)}>
                        {tr('UnassignedTime.delete', 'Delete')}
                      </Button>
                    </div>
                    {deleting === entry.id ? (
                      <div className="tm-row tm-row--wrap" role="group">
                        <span>
                          {tr(
                            'UnassignedTime.deleteConfirm',
                            'Delete this time? It cannot be brought back.',
                          )}
                        </span>
                        <Button
                          size="compact"
                          tone="destructive"
                          loading={remove.isPending}
                          loadingLabel={tr('UnassignedTime.deleting', 'Deleting')}
                          onClick={() => remove.mutate(entry.id)}
                        >
                          {tr('UnassignedTime.deleteYes', 'Delete time')}
                        </Button>
                        <Button size="compact" tone="text" onClick={() => setDeleting(null)}>
                          {tr('UnassignedTime.cancel', 'Cancel')}
                        </Button>
                      </div>
                    ) : null}
                    {assigning === entry.id ? (
                      <AssignForm
                        api={api}
                        organizationSlug={organizationSlug}
                        sheetId={sheet.id}
                        entry={entry}
                        projectId={projectId}
                        onDone={refresh}
                        onCancel={() => setAssigning(null)}
                        tr={tr}
                      />
                    ) : null}
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {remove.isError ? (
        <InlineAlert tone="danger" title={tr('UnassignedTime.notDeleted', 'Not deleted')} live>
          {describeApiErrorNow(remove.error)}
        </InlineAlert>
      ) : null}
    </section>
  );
}

/** Item 8: automatic entries are marked as such, with what that means in the hover help. */
export function SourceMark({ source, tr }: { source: TimesheetEntry['source']; tr: TOr }) {
  if (source !== 'automatic') return <>{tr('UnassignedTime.manual', 'Manual')}</>;
  // A badge is not a control, so its meaning is written beside it, not in a hover bubble.
  return (
    <>
      <Badge>{tr('UnassignedTime.automatic', 'Automatic')}</Badge>{' '}
      <span className="tm-field__hint">
        {/* UX test T-P1-3: a person's own time is described, never doubted. */}
        {tr('UnassignedTime.fromDevice', 'From your device activity')}
      </span>
    </>
  );
}

function AssignForm({
  api,
  organizationSlug,
  sheetId,
  entry,
  projectId,
  onDone,
  onCancel,
  tr,
}: {
  api: ApiClient;
  organizationSlug: string;
  sheetId: string;
  entry: TimesheetEntry;
  projectId: string | null;
  onDone: (view: Timesheet) => Promise<void>;
  onCancel: () => void;
  tr: TOr;
}) {
  const [workItemId, setWorkItemId] = useState('');
  const [minutes, setMinutes] = useState(String(entry.minutes));
  // Only tasks the person can see (the API lists no others), in the entry's project if it has one.
  const tasks = useQuery({
    queryKey: ['unassigned-time-tasks', organizationSlug, projectId],
    queryFn: () =>
      listWorkItems(api, organizationSlug, {
        ...(projectId === null ? {} : { projectId }),
        limit: MAX_WORK_ITEM_PAGE,
      }),
  });
  const choices = (tasks.data ?? []).filter((item) => item.deletedAt === null);
  const amount = Number(minutes);
  const valid = Number.isInteger(amount) && amount >= 1 && amount <= entry.minutes;
  const save = useMutation({
    mutationFn: () =>
      amount === entry.minutes
        ? moveTimesheetEntries(api, organizationSlug, sheetId, {
            entryIds: [entry.id],
            workItemId,
          })
        : splitTimesheetEntry(api, organizationSlug, sheetId, {
            entryId: entry.id,
            minutes: amount,
            workItemId,
          }),
    onSuccess: onDone,
  });

  return (
    <form
      className="tm-stack"
      onSubmit={(event) => {
        event.preventDefault();
        if (valid && workItemId !== '') save.mutate();
      }}
    >
      <Select
        label={tr('UnassignedTime.task', 'Task')}
        value={workItemId}
        disabled={tasks.isPending}
        onChange={(event) => setWorkItemId(event.target.value)}
      >
        <option value="">{tr('UnassignedTime.chooseTask', 'Choose a task')}</option>
        {choices.map((item) => (
          <option key={item.id} value={item.id}>
            {item.title}
          </option>
        ))}
      </Select>
      <Field
        label={tr('UnassignedTime.minutes', 'Minutes to put on it')}
        hint={tr('UnassignedTime.minutesHint', 'All of it, or part: the rest stays unassigned.')}
        name="minutes"
        type="number"
        inputMode="numeric"
        min={1}
        max={entry.minutes}
        value={minutes}
        error={
          valid
            ? undefined
            : tr('UnassignedTime.minutesError', 'Enter whole minutes, at most {max}.').replace(
                '{max}',
                String(entry.minutes),
              )
        }
        onChange={(event) => setMinutes(event.target.value)}
      />
      {save.isError ? (
        <InlineAlert tone="danger" title={tr('UnassignedTime.notSaved', 'Not saved')} live>
          {describeApiErrorNow(save.error)}
        </InlineAlert>
      ) : null}
      <div className="tm-row">
        <Button
          type="submit"
          size="compact"
          tone="ink"
          disabled={!valid || workItemId === ''}
          loading={save.isPending}
          loadingLabel={tr('UnassignedTime.saving', 'Saving')}
        >
          {tr('UnassignedTime.save', 'Put it on the task')}
        </Button>
        <Button type="button" size="compact" tone="text" onClick={onCancel}>
          {tr('UnassignedTime.cancel', 'Cancel')}
        </Button>
      </div>
    </form>
  );
}

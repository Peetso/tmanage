'use client';

import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Checkbox, Field, InlineAlert, LoadingRegion, Select, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  listAutomationSchedules,
  scheduleAutomationTemplate,
  type ScheduleInterval,
  type ScheduleSpec,
} from '../../lib/api/automation-schedules';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface AutomationSchedulesScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

const INTERVALS: readonly { value: ScheduleInterval; label: string }[] = [
  { value: 'hourly', label: 'Hourly' },
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
];

const DAYS: readonly { value: number; label: string }[] = [
  { value: 0, label: 'Sunday' },
  { value: 1, label: 'Monday' },
  { value: 2, label: 'Tuesday' },
  { value: 3, label: 'Wednesday' },
  { value: 4, label: 'Thursday' },
  { value: 5, label: 'Friday' },
  { value: 6, label: 'Saturday' },
];

/**
 * **Automations scheduled triggers (x167).**
 *
 * `41-WHOLE-APP-SCREEN-AND-STATE-MATRIX` §Automations. One tenant's scheduled triggers — a cron-like
 * recurrence for a workflow template. It lists a tenant's schedules soonest-due first, and records a
 * new one (template, interval, and the hour / day the interval uses, with an enabled toggle).
 *
 * ## What it does, and what it cannot
 *
 * - **A schedule is recorded, not fired.** A background dispatcher that wakes on the next-run instant
 *   and enqueues the workflow is worker infrastructure (Needs-Peter); this screen only records and
 *   lists. The next-run instant it shows is computed by the API at write time.
 * - **A schedule is created, never edited.** The API ships no editor and no per-schedule toggle, so
 *   the enabled state is chosen once, at creation.
 */
export function AutomationSchedulesScreen({
  organizationSlug,
  organizationName,
  client,
}: AutomationSchedulesScreenProps) {
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();
  const queryKey = ['automation-schedules', organizationSlug];

  const schedules = useQuery({
    queryKey,
    queryFn: () => listAutomationSchedules(api, organizationSlug),
  });

  const [templateId, setTemplateId] = useState('');
  const [interval, setInterval] = useState<ScheduleInterval>('daily');
  const [hour, setHour] = useState('9');
  const [dayOfWeek, setDayOfWeek] = useState('1');
  const [enabled, setEnabled] = useState(true);

  const usesHour = interval === 'daily' || interval === 'weekly';
  const usesDay = interval === 'weekly';

  const create = useMutation({
    mutationFn: () =>
      scheduleAutomationTemplate(api, organizationSlug, templateId.trim(), {
        interval,
        ...(usesHour ? { hour: Number(hour) } : {}),
        ...(usesDay ? { dayOfWeek: Number(dayOfWeek) } : {}),
        enabled,
      }),
    onSuccess: async () => {
      setTemplateId('');
      await queryClient.invalidateQueries({ queryKey });
    },
  });

  const rows = schedules.data ?? [];
  const canCreate = templateId.trim() !== '' && !create.isPending;

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      title="Scheduled triggers"
      description="When a workflow template should run on its own. A schedule is recorded here; a background runner fires it."
    >
      <section className="tm-panel tm-stack" aria-labelledby="tm-schedule-new-heading">
        <h2 id="tm-schedule-new-heading" className="tm-eyebrow">
          New schedule
        </h2>
        <form
          className="tm-stack"
          noValidate
          onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            if (canCreate) create.mutate();
          }}
        >
          <Field
            label="Workflow template ID"
            name="templateId"
            value={templateId}
            onChange={(event) => setTemplateId(event.target.value)}
            hint="The template this schedule runs. It must belong to this organization."
            required
          />
          <Select
            label="Interval"
            name="interval"
            value={interval}
            onChange={(event) => setInterval(event.target.value as ScheduleInterval)}
            hint="How often the schedule fires."
          >
            {INTERVALS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>

          {usesHour ? (
            <Field
              label="Hour of day (UTC)"
              name="hour"
              type="number"
              min={0}
              max={23}
              value={hour}
              onChange={(event) => setHour(event.target.value)}
              hint="0–23. The hour, in UTC, the schedule fires."
            />
          ) : null}

          {usesDay ? (
            <Select
              label="Day of week"
              name="dayOfWeek"
              value={dayOfWeek}
              onChange={(event) => setDayOfWeek(event.target.value)}
              hint="The day of the week the weekly schedule fires."
            >
              {DAYS.map((option) => (
                <option key={option.value} value={String(option.value)}>
                  {option.label}
                </option>
              ))}
            </Select>
          ) : null}

          <Checkbox
            label="Enabled"
            name="enabled"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
            hint="A disabled schedule is recorded but a runner will skip it."
          />

          {create.isError ? (
            <InlineAlert tone="danger" title="Could not create the schedule" live>
              {describeError(create.error)}
            </InlineAlert>
          ) : null}

          <div className="tm-row">
            <Button
              type="submit"
              tone="ink"
              size="accessible"
              loading={create.isPending}
              loadingLabel="Scheduling"
              disabled={!canCreate}
            >
              Create schedule
            </Button>
          </div>
        </form>
      </section>

      <section
        className="tm-panel tm-panel--quiet tm-stack"
        aria-labelledby="tm-schedule-list-heading"
      >
        <h2 id="tm-schedule-list-heading" className="tm-eyebrow">
          Schedules
        </h2>

        {schedules.isError ? (
          <InlineAlert tone="danger" title="Could not load the schedules" live>
            {describeError(schedules.error)}
          </InlineAlert>
        ) : null}

        {schedules.isPending ? (
          <LoadingRegion label="Loading the schedules.">
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {!schedules.isPending && !schedules.isError && rows.length === 0 ? (
          <InlineAlert tone="neutral" title="No schedules yet">
            Add a schedule above. Each one records when a workflow template should run.
          </InlineAlert>
        ) : null}

        {rows.length > 0 ? (
          <div
            className="tm-table-scroll"
            // A scrollable region must be focusable or a keyboard cannot reach its overflow columns
            // (WCAG 2.2 2.1.1), matching the other screens' tables.
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
            tabIndex={0}
            role="region"
            aria-label="Scheduled triggers"
          >
            <table className="tm-table">
              <caption className="tm-visually-hidden">
                This organization&rsquo;s scheduled triggers, {rows.length} shown, soonest due
                first.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Template</th>
                  <th scope="col">Recurrence</th>
                  <th scope="col">Next run (UTC)</th>
                  <th scope="col">Enabled</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((schedule) => (
                  <tr key={schedule.id}>
                    <th scope="row" className="tm-table__title">
                      {schedule.templateId}
                    </th>
                    <td>{describeRecurrence(schedule.spec)}</td>
                    <td>{schedule.nextRunAt}</td>
                    <td>{schedule.enabled ? 'Yes' : 'No'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>
    </AppShell>
  );
}

/** A short human description of a recurrence spec. */
function describeRecurrence(spec: ScheduleSpec): string {
  if (spec.interval === 'hourly') return 'Every hour';
  const hour = spec.hour ?? 0;
  const at = `at ${String(hour).padStart(2, '0')}:00`;
  if (spec.interval === 'daily') return `Daily ${at}`;
  const day = DAYS.find((d) => d.value === (spec.dayOfWeek ?? 0))?.label ?? 'Sunday';
  return `Weekly on ${day} ${at}`;
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}

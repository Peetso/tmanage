'use client';

import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Checkbox, Field, InlineAlert, LoadingRegion, Select, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { AutomationSectionTabs } from './AutomationSectionTabs';
import { listWorkflowTemplates } from '../../lib/api/automations';
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

  // The library, read to offer automations by name and to name each schedule's template. If it
  // cannot be read the form falls back to the template id field.
  const templates = useQuery({
    queryKey: ['workflow-templates', organizationSlug],
    queryFn: async () => (await listWorkflowTemplates(api, organizationSlug)) ?? [],
  });
  const library = Array.isArray(templates.data) ? templates.data : [];
  const templateName = (id: string): string => library.find((t) => t.id === id)?.name ?? id;

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
  const onCount = rows.filter((schedule) => schedule.enabled).length;

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="admin"
      eyebrow="Control center · Automations · Schedules"
      title="Scheduled triggers"
      {...(rows.length > 0 ? { titleMeta: `${onCount} on · ${rows.length - onCount} off` } : {})}
    >
      <div className="tm-aut">
        <AutomationSectionTabs
          organizationSlug={organizationSlug}
          current="schedules"
          count={rows.length}
        />

        <div className="tm-aut-split tm-aut-split--wide">
          <section className="tm-aut-col" aria-labelledby="tm-schedule-list-heading">
            <h2 id="tm-schedule-list-heading" className="tm-visually-hidden">
              Schedules
            </h2>
            <p className="tm-aut-lede">
              When an automation should run on its own. Every schedule is recorded here, times are
              in UTC, and each run lands in the run history.
            </p>

            {schedules.isError ? (
              <InlineAlert tone="danger" title="Could not load the schedules" live>
                {describeError(schedules.error)}
              </InlineAlert>
            ) : null}

            <div className="tm-aut-tablecard">
              {schedules.isPending ? (
                <div className="tm-aut-pad">
                  <LoadingRegion label="Loading the schedules.">
                    <Skeleton height="var(--row)" />
                    <Skeleton height="var(--row)" />
                  </LoadingRegion>
                </div>
              ) : null}

              {!schedules.isPending && !schedules.isError && rows.length === 0 ? (
                <div className="tm-aut-empty">
                  <p className="tm-aut-empty__title">No schedules yet</p>
                  <p className="tm-aut-empty__body">
                    Add a schedule with the form. Each one records when an automation should run.
                  </p>
                </div>
              ) : null}

              {rows.length > 0 ? (
                <div
                  className="tm-aut-tablecard__scroll"
                  // A scrollable region must be focusable or a keyboard cannot reach its overflow
                  // columns (WCAG 2.2 2.1.1), matching the other screens' tables.
                  // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
                  tabIndex={0}
                  role="region"
                  aria-label="Scheduled triggers"
                >
                  <table className="tm-aut-table">
                    <caption className="tm-visually-hidden">
                      This organization&rsquo;s scheduled triggers, {rows.length} shown, soonest due
                      first.
                    </caption>
                    <thead>
                      <tr>
                        <th scope="col">Template</th>
                        <th scope="col" className="tm-aut-hide-sm">
                          Next run (UTC)
                        </th>
                        <th scope="col" className="tm-aut-end">
                          Enabled
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((schedule) => (
                        <tr key={schedule.id}>
                          <th scope="row">
                            <span className="tm-aut-rowtitle">
                              {templateName(schedule.templateId)}
                            </span>
                            <span className="tm-aut-rowsub">
                              {describeRecurrence(schedule.spec)}
                            </span>
                          </th>
                          <td className="tm-aut-mono tm-aut-hide-sm">
                            {formatNextRun(schedule.nextRunAt)}
                          </td>
                          <td className="tm-aut-end">
                            <span
                              className={`tm-aut-state ${schedule.enabled ? 'tm-aut-state--live' : 'tm-aut-state--off'}`}
                            >
                              {schedule.enabled ? 'On' : 'Off'}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
            </div>
          </section>

          <div className="tm-aut-col">
            <section className="tm-aut-card tm-card--ink" aria-labelledby="tm-schedule-new-heading">
              <p className="tm-aut-eyebrow">New schedule</p>
              <h2 id="tm-schedule-new-heading" className="tm-aut-card__title">
                Run an automation on its own
              </h2>
              <form
                className="tm-stack"
                noValidate
                onSubmit={(event: FormEvent<HTMLFormElement>) => {
                  event.preventDefault();
                  if (canCreate) create.mutate();
                }}
              >
                {library.length > 0 ? (
                  <Select
                    label="Automation"
                    name="templateId"
                    value={templateId}
                    onChange={(event) => setTemplateId(event.target.value)}
                    hint="The automation this schedule runs."
                    required
                  >
                    <option value="">Choose an automation…</option>
                    {library.map((template) => (
                      <option key={template.id} value={template.id}>
                        {template.name}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <Field
                    label="Workflow template ID"
                    name="templateId"
                    value={templateId}
                    onChange={(event) => setTemplateId(event.target.value)}
                    hint="The template this schedule runs. It must belong to this organization."
                    required
                  />
                )}
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

                <div className="tm-aut-actions">
                  <Button
                    type="submit"
                    tone="lime"
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

            <section className="tm-aut-card" aria-labelledby="tm-schedule-rules-heading">
              <p className="tm-aut-eyebrow">
                <span className="tm-aut-eyebrow__square" aria-hidden="true" />
                How a schedule runs
              </p>
              <h2
                id="tm-schedule-rules-heading"
                className="tm-aut-card__title tm-aut-card__title--section"
              >
                One automation, at a fixed time, recorded every time
              </h2>
              <ol className="tm-aut-facts tm-aut-facts--numbered">
                <li>Times are kept in UTC, so a schedule never drifts with daylight saving.</li>
                <li>A disabled schedule stays on the list and is skipped until it is turned on.</li>
                <li>Every run, succeeded or failed, is written to the run history.</li>
                <li>A schedule only runs automations that belong to this organization.</li>
              </ol>
            </section>
          </div>
        </div>
      </div>
    </AppShell>
  );
}

/** The next run as AUT-04's mono stamp, e.g. `28 SEP 08:00`. */
function formatNextRun(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const day = date
    .toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })
    .toUpperCase();
  return `${day} ${date.toISOString().slice(11, 16)}`;
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

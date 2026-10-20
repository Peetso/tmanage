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
import { useT } from '../../lib/i18n/use-t';

export interface AutomationSchedulesScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

const INTERVALS: readonly ScheduleInterval[] = ['hourly', 'daily', 'weekly'];

const DAY_VALUES: readonly number[] = [0, 1, 2, 3, 4, 5, 6];

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
  const t = useT();
  const queryKey = ['automation-schedules', organizationSlug];

  const intervalLabel = (value: ScheduleInterval): string => {
    switch (value) {
      case 'hourly':
        return t('AutomationSchedulesScreen.intervalHourly');
      case 'daily':
        return t('AutomationSchedulesScreen.intervalDaily');
      default:
        return t('AutomationSchedulesScreen.intervalWeekly');
    }
  };

  const dayLabel = (value: number): string => {
    switch (value) {
      case 0:
        return t('AutomationSchedulesScreen.daySunday');
      case 1:
        return t('AutomationSchedulesScreen.dayMonday');
      case 2:
        return t('AutomationSchedulesScreen.dayTuesday');
      case 3:
        return t('AutomationSchedulesScreen.dayWednesday');
      case 4:
        return t('AutomationSchedulesScreen.dayThursday');
      case 5:
        return t('AutomationSchedulesScreen.dayFriday');
      default:
        return t('AutomationSchedulesScreen.daySaturday');
    }
  };

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
      eyebrow={t('AutomationSchedulesScreen.eyebrow')}
      title={t('AutomationSchedulesScreen.title')}
      {...(rows.length > 0
        ? {
            titleMeta: `${onCount} ${t('AutomationSchedulesScreen.metaOn')} · ${rows.length - onCount} ${t('AutomationSchedulesScreen.metaOff')}`,
          }
        : {})}
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
              {t('AutomationSchedulesScreen.schedulesHeading')}
            </h2>
            <p className="tm-aut-lede">{t('AutomationSchedulesScreen.lede')}</p>

            {schedules.isError ? (
              <InlineAlert tone="danger" title={t('AutomationSchedulesScreen.errorLoadTitle')} live>
                {describeError(t, schedules.error)}
              </InlineAlert>
            ) : null}

            <div className="tm-aut-tablecard">
              {schedules.isPending ? (
                <div className="tm-aut-pad">
                  <LoadingRegion label={t('AutomationSchedulesScreen.loadingLabel')}>
                    <Skeleton height="var(--row)" />
                    <Skeleton height="var(--row)" />
                  </LoadingRegion>
                </div>
              ) : null}

              {!schedules.isPending && !schedules.isError && rows.length === 0 ? (
                <div className="tm-aut-empty">
                  <p className="tm-aut-empty__title">{t('AutomationSchedulesScreen.emptyTitle')}</p>
                  <p className="tm-aut-empty__body">{t('AutomationSchedulesScreen.emptyBody')}</p>
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
                  aria-label={t('AutomationSchedulesScreen.tableLabel')}
                >
                  <table className="tm-aut-table">
                    <caption className="tm-visually-hidden">
                      {t('AutomationSchedulesScreen.captionPrefix')} {rows.length}{' '}
                      {t('AutomationSchedulesScreen.captionSuffix')}
                    </caption>
                    <thead>
                      <tr>
                        <th scope="col">{t('AutomationSchedulesScreen.colTemplate')}</th>
                        <th scope="col" className="tm-aut-hide-sm">
                          {t('AutomationSchedulesScreen.colNextRun')}
                        </th>
                        <th scope="col" className="tm-aut-end">
                          {t('AutomationSchedulesScreen.colEnabled')}
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
                              {describeRecurrence(t, dayLabel, schedule.spec)}
                            </span>
                          </th>
                          <td className="tm-aut-mono tm-aut-hide-sm">
                            {formatNextRun(schedule.nextRunAt)}
                          </td>
                          <td className="tm-aut-end">
                            <span
                              className={`tm-aut-state ${schedule.enabled ? 'tm-aut-state--live' : 'tm-aut-state--off'}`}
                            >
                              {schedule.enabled
                                ? t('AutomationSchedulesScreen.stateOn')
                                : t('AutomationSchedulesScreen.stateOff')}
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
              <p className="tm-aut-eyebrow">{t('AutomationSchedulesScreen.newScheduleEyebrow')}</p>
              <h2 id="tm-schedule-new-heading" className="tm-aut-card__title">
                {t('AutomationSchedulesScreen.newScheduleTitle')}
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
                    label={t('AutomationSchedulesScreen.automationLabel')}
                    name="templateId"
                    value={templateId}
                    onChange={(event) => setTemplateId(event.target.value)}
                    hint={t('AutomationSchedulesScreen.automationHint')}
                    required
                  >
                    <option value="">{t('AutomationSchedulesScreen.chooseAutomation')}</option>
                    {library.map((template) => (
                      <option key={template.id} value={template.id}>
                        {template.name}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <Field
                    label={t('AutomationSchedulesScreen.templateIdLabel')}
                    name="templateId"
                    value={templateId}
                    onChange={(event) => setTemplateId(event.target.value)}
                    hint={t('AutomationSchedulesScreen.templateIdHint')}
                    required
                  />
                )}
                <Select
                  label={t('AutomationSchedulesScreen.intervalLabel')}
                  name="interval"
                  value={interval}
                  onChange={(event) => setInterval(event.target.value as ScheduleInterval)}
                  hint={t('AutomationSchedulesScreen.intervalHint')}
                >
                  {INTERVALS.map((option) => (
                    <option key={option} value={option}>
                      {intervalLabel(option)}
                    </option>
                  ))}
                </Select>

                {usesHour ? (
                  <Field
                    label={t('AutomationSchedulesScreen.hourLabel')}
                    name="hour"
                    type="number"
                    min={0}
                    max={23}
                    value={hour}
                    onChange={(event) => setHour(event.target.value)}
                    hint={t('AutomationSchedulesScreen.hourHint')}
                  />
                ) : null}

                {usesDay ? (
                  <Select
                    label={t('AutomationSchedulesScreen.dayOfWeekLabel')}
                    name="dayOfWeek"
                    value={dayOfWeek}
                    onChange={(event) => setDayOfWeek(event.target.value)}
                    hint={t('AutomationSchedulesScreen.dayOfWeekHint')}
                  >
                    {DAY_VALUES.map((option) => (
                      <option key={option} value={String(option)}>
                        {dayLabel(option)}
                      </option>
                    ))}
                  </Select>
                ) : null}

                <Checkbox
                  label={t('AutomationSchedulesScreen.enabledLabel')}
                  name="enabled"
                  checked={enabled}
                  onChange={(event) => setEnabled(event.target.checked)}
                  hint={t('AutomationSchedulesScreen.enabledHint')}
                />

                {create.isError ? (
                  <InlineAlert
                    tone="danger"
                    title={t('AutomationSchedulesScreen.errorCreateTitle')}
                    live
                  >
                    {describeError(t, create.error)}
                  </InlineAlert>
                ) : null}

                <div className="tm-aut-actions">
                  <Button
                    type="submit"
                    tone="lime"
                    size="accessible"
                    loading={create.isPending}
                    loadingLabel={t('AutomationSchedulesScreen.scheduling')}
                    disabled={!canCreate}
                  >
                    {t('AutomationSchedulesScreen.createButton')}
                  </Button>
                </div>
              </form>
            </section>

            <section className="tm-aut-card" aria-labelledby="tm-schedule-rules-heading">
              <p className="tm-aut-eyebrow">
                <span className="tm-aut-eyebrow__square" aria-hidden="true" />
                {t('AutomationSchedulesScreen.howEyebrow')}
              </p>
              <h2
                id="tm-schedule-rules-heading"
                className="tm-aut-card__title tm-aut-card__title--section"
              >
                {t('AutomationSchedulesScreen.howTitle')}
              </h2>
              <ol className="tm-aut-facts tm-aut-facts--numbered">
                <li>{t('AutomationSchedulesScreen.fact1')}</li>
                <li>{t('AutomationSchedulesScreen.fact2')}</li>
                <li>{t('AutomationSchedulesScreen.fact3')}</li>
                <li>{t('AutomationSchedulesScreen.fact4')}</li>
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
function describeRecurrence(
  t: ReturnType<typeof useT>,
  dayLabel: (value: number) => string,
  spec: ScheduleSpec,
): string {
  if (spec.interval === 'hourly') return t('AutomationSchedulesScreen.everyHour');
  const hour = spec.hour ?? 0;
  const at = `${t('AutomationSchedulesScreen.at')} ${String(hour).padStart(2, '0')}:00`;
  if (spec.interval === 'daily') return `${t('AutomationSchedulesScreen.daily')} ${at}`;
  const day = dayLabel(spec.dayOfWeek ?? 0);
  return `${t('AutomationSchedulesScreen.weeklyOn')} ${day} ${at}`;
}

function describeError(t: ReturnType<typeof useT>, error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return t('AutomationSchedulesScreen.errorApiUnreachable');
  return t('AutomationSchedulesScreen.errorGeneric');
}

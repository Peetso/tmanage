'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Announce, Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import '../../styles/screens/insights.css';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  INSIGHT_REPORT_KINDS,
  createInsightReportSchedule,
  deleteInsightReportSchedule,
  listInsightReportSchedules,
} from '../../lib/api/insight-report-schedules';
import type {
  InsightReportCadence,
  InsightReportKind,
  ReportScheduleView,
} from '../../lib/api/insight-report-schedules';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface ReportSchedulesScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** Injected in tests. Defaults to the browser client. */
  client?: ApiClient;
}

const REPORT_KIND_LABELS: Readonly<Record<InsightReportKind, string>> = {
  portfolio: 'Portfolio',
  'delivery-flow': 'Delivery flow',
  'approval-cycle': 'Approval cycle',
  workload: 'Workload',
  adoption: 'Adoption',
  forecast: 'Forecast',
};

const DAY_LABELS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

function formatHour(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00 UTC`;
}

function describeSchedule(schedule: ReportScheduleView): string {
  const when =
    schedule.cadence === 'weekly' && schedule.dayOfWeek !== null
      ? `Weekly · ${DAY_LABELS[schedule.dayOfWeek] ?? `day ${schedule.dayOfWeek}`}`
      : 'Daily';
  return `${when} at ${formatHour(schedule.hour)}`;
}

/**
 * **Insight report schedules** (module 15, x228).
 *
 * `38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP` §Insights & reporting: the insights reads and saved views
 * exist, but a person cannot say "run this report every Monday at 08:00". This screen is that editor —
 * a form to define a recurring report (a report kind, a daily/weekly cadence, an hour and, for weekly,
 * a day), the list of the caller's own schedules with the computed next run, and a "Remove" action.
 *
 * The decisions are the sibling insights screens':
 * 1. **Authorization is the API's.** All routes sit behind `work.read`; a caller without it sees the
 *    API's 403 turned into a sentence in the panel's alert, never a blank page.
 * 2. **Private to the owner.** The list is only ever the caller's own schedules (the API scopes by
 *    owner), and a removed schedule is one the caller owns — an id that is not the caller's answers 404.
 * 3. **Definition only.** The screen defines when a report is due; it does not run it. There is no
 *    dispatcher and no delivery in this slice — the next-run time is shown, not acted on.
 */
export function ReportSchedulesScreen({
  organizationSlug,
  organizationName,
  client,
}: ReportSchedulesScreenProps) {
  const api = client ?? browserApiClient();
  const queries = useQueryClient();
  const listKey = ['insight-report-schedules', organizationSlug] as const;

  const [reportKey, setReportKey] = useState<InsightReportKind>('portfolio');
  const [cadence, setCadence] = useState<InsightReportCadence>('daily');
  const [hour, setHour] = useState(8);
  const [dayOfWeek, setDayOfWeek] = useState(1);

  const schedules = useQuery({
    queryKey: listKey,
    queryFn: () => listInsightReportSchedules(api, organizationSlug),
  });

  const save = useMutation({
    mutationFn: (): Promise<ReportScheduleView> =>
      createInsightReportSchedule(api, organizationSlug, {
        reportKey,
        cadence,
        hour,
        dayOfWeek: cadence === 'weekly' ? dayOfWeek : null,
      }),
    onSuccess: () => {
      void queries.invalidateQueries({ queryKey: listKey });
    },
  });

  const remove = useMutation({
    mutationFn: (scheduleId: string) =>
      deleteInsightReportSchedule(api, organizationSlug, scheduleId),
    onSuccess: () => {
      void queries.invalidateQueries({ queryKey: listKey });
    },
  });

  const rows = schedules.data ?? [];

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="insights"
      eyebrow="Insights"
      title="Report schedules"
      description="Schedule an insights report to run on a daily or weekly cadence."
    >
      <div className="tm-ins tm-ins-tool">
        <section className="tm-panel tm-stack" aria-labelledby="tm-report-schedule-editor">
          <h2 id="tm-report-schedule-editor" className="tm-eyebrow">
            New schedule
          </h2>

          <form
            className="tm-stack"
            onSubmit={(event) => {
              event.preventDefault();
              if (!save.isPending) save.mutate();
            }}
          >
            <div className="tm-field">
              <label className="tm-field__label" htmlFor="tm-report-schedule-report">
                Report
              </label>
              <select
                id="tm-report-schedule-report"
                className="tm-field__control"
                value={reportKey}
                onChange={(event) => setReportKey(event.target.value as InsightReportKind)}
              >
                {INSIGHT_REPORT_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {REPORT_KIND_LABELS[kind]}
                  </option>
                ))}
              </select>
            </div>

            <div className="tm-field">
              <label className="tm-field__label" htmlFor="tm-report-schedule-cadence">
                Cadence
              </label>
              <select
                id="tm-report-schedule-cadence"
                className="tm-field__control"
                value={cadence}
                onChange={(event) => setCadence(event.target.value as InsightReportCadence)}
              >
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
              </select>
            </div>

            {cadence === 'weekly' ? (
              <div className="tm-field">
                <label className="tm-field__label" htmlFor="tm-report-schedule-day">
                  Day of week
                </label>
                <select
                  id="tm-report-schedule-day"
                  className="tm-field__control"
                  value={dayOfWeek}
                  onChange={(event) => setDayOfWeek(Number(event.target.value))}
                >
                  {DAY_LABELS.map((label, index) => (
                    <option key={label} value={index}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}

            <div className="tm-field">
              <label className="tm-field__label" htmlFor="tm-report-schedule-hour">
                Hour (UTC)
              </label>
              <input
                id="tm-report-schedule-hour"
                className="tm-field__control"
                type="number"
                min={0}
                max={23}
                value={hour}
                onChange={(event) => setHour(Number(event.target.value))}
              />
              <span className="tm-field__hint">The hour of day, 0–23, in UTC.</span>
            </div>

            {save.isError ? (
              <InlineAlert tone="danger" title="Could not create the schedule" live>
                {describeError(save.error)}
              </InlineAlert>
            ) : null}

            <div className="tm-row">
              <Button
                type="submit"
                tone="ink"
                size="accessible"
                disabled={save.isPending}
                loading={save.isPending}
                loadingLabel="Saving"
              >
                Create schedule
              </Button>
            </div>
          </form>
        </section>

        <section
          className="tm-panel tm-panel--quiet tm-stack"
          aria-labelledby="tm-report-schedule-list"
        >
          <h2 id="tm-report-schedule-list" className="tm-eyebrow">
            Your schedules
          </h2>

          {schedules.isError ? (
            <InlineAlert tone="danger" title="Could not load your schedules" live>
              {describeError(schedules.error)}
            </InlineAlert>
          ) : null}

          {remove.isError ? (
            <InlineAlert tone="danger" title="Could not remove the schedule" live>
              {describeError(remove.error)}
            </InlineAlert>
          ) : null}

          {schedules.isPending ? (
            <LoadingRegion label="Loading your schedules.">
              <Skeleton height="var(--row)" />
              <Skeleton height="var(--row)" />
            </LoadingRegion>
          ) : null}

          {!schedules.isPending && !schedules.isError && rows.length === 0 ? (
            <InlineAlert tone="neutral" title="No schedules yet">
              Define a recurring report above and it will appear here with its next run.
            </InlineAlert>
          ) : null}

          {rows.length > 0 ? (
            <ul className="tm-list tm-stack">
              {rows.map((schedule) => (
                <li key={schedule.id} className="tm-row tm-row--wrap">
                  <div className="tm-stack tm-stack--tight">
                    <strong>{REPORT_KIND_LABELS[schedule.reportKey]}</strong>
                    <span className="tm-field__hint">
                      {describeSchedule(schedule)} · Next run{' '}
                      {new Date(schedule.nextRunAt).toISOString().replace('T', ' ').slice(0, 16)}{' '}
                      UTC
                    </span>
                  </div>
                  <Button
                    tone="outline"
                    size="accessible"
                    loading={remove.isPending && remove.variables === schedule.id}
                    loadingLabel="Removing"
                    onClick={() => remove.mutate(schedule.id)}
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
        </section>

        <Announce message={save.isSuccess ? 'Schedule created.' : ''} />
      </div>
    </AppShell>
  );
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}

'use client';

import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Announce, Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import '../../styles/screens/insights.css';
import { browserApiClient } from '../../lib/api/browser-client';
import { useT } from '../../lib/i18n/use-t';
import { FormCheckMessage, useFormCheck } from '../../lib/forms/form-check';
import { TeachingEmptyState, focusFirstField } from '../help/TeachingEmptyState';
import { useShellCapability } from '../shell/use-shell-capability';
import type { MessageKey } from '../../lib/i18n/t';
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
import type { ApiClient } from '../../lib/api/client';
import { useDescribeApiError } from '../../lib/api/describe-error';

export interface ReportSchedulesScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** Injected in tests. Defaults to the browser client. */
  client?: ApiClient;
}

const REPORT_KIND_KEY: Readonly<Record<InsightReportKind, MessageKey>> = {
  portfolio: 'ReportSchedulesScreen.reportPortfolio',
  'delivery-flow': 'ReportSchedulesScreen.reportDeliveryFlow',
  'approval-cycle': 'ReportSchedulesScreen.reportApprovalCycle',
  workload: 'ReportSchedulesScreen.reportWorkload',
  adoption: 'ReportSchedulesScreen.reportAdoption',
  forecast: 'ReportSchedulesScreen.reportForecast',
};

const DAY_KEY: Readonly<Record<0 | 1 | 2 | 3 | 4 | 5 | 6, MessageKey>> = {
  0: 'ReportSchedulesScreen.daySunday',
  1: 'ReportSchedulesScreen.dayMonday',
  2: 'ReportSchedulesScreen.dayTuesday',
  3: 'ReportSchedulesScreen.dayWednesday',
  4: 'ReportSchedulesScreen.dayThursday',
  5: 'ReportSchedulesScreen.dayFriday',
  6: 'ReportSchedulesScreen.daySaturday',
};

const DAY_ORDER = [0, 1, 2, 3, 4, 5, 6] as const;

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
  const describeError = useDescribeApiError();
  const api = client ?? browserApiClient();
  const queries = useQueryClient();
  const t = useT();
  const canUse = useShellCapability(organizationSlug, client);
  const firstStep = useRef<HTMLFormElement>(null);
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

  // QA-FIX-S M2: the constraints in the markup are reported here, in the app's words.
  const check = useFormCheck();
  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="insights"
      eyebrow={t('ReportSchedulesScreen.eyebrow')}
      title={t('ReportSchedulesScreen.title')}
      description={t('ReportSchedulesScreen.description')}
    >
      <div className="tm-ins tm-ins-tool">
        <section className="tm-panel tm-stack" aria-labelledby="tm-report-schedule-editor">
          <h2 id="tm-report-schedule-editor" className="tm-eyebrow">
            {t('ReportSchedulesScreen.newSchedule')}
          </h2>

          <form
            noValidate
            ref={firstStep}
            className="tm-stack"
            {...check.handlers(() => {
              if (!save.isPending) save.mutate();
            })}
          >
            <div className="tm-field">
              <label className="tm-field__label" htmlFor="tm-report-schedule-report">
                {t('ReportSchedulesScreen.report')}
              </label>
              <select
                id="tm-report-schedule-report"
                className="tm-field__control"
                value={reportKey}
                onChange={(event) => setReportKey(event.target.value as InsightReportKind)}
              >
                {INSIGHT_REPORT_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {t(REPORT_KIND_KEY[kind])}
                  </option>
                ))}
              </select>
            </div>

            <div className="tm-field">
              <label className="tm-field__label" htmlFor="tm-report-schedule-cadence">
                {t('ReportSchedulesScreen.cadence')}
              </label>
              <select
                id="tm-report-schedule-cadence"
                className="tm-field__control"
                value={cadence}
                onChange={(event) => setCadence(event.target.value as InsightReportCadence)}
              >
                <option value="daily">{t('ReportSchedulesScreen.daily')}</option>
                <option value="weekly">{t('ReportSchedulesScreen.weekly')}</option>
              </select>
            </div>

            {cadence === 'weekly' ? (
              <div className="tm-field">
                <label className="tm-field__label" htmlFor="tm-report-schedule-day">
                  {t('ReportSchedulesScreen.dayOfWeek')}
                </label>
                <select
                  id="tm-report-schedule-day"
                  className="tm-field__control"
                  value={dayOfWeek}
                  onChange={(event) => setDayOfWeek(Number(event.target.value))}
                >
                  {DAY_ORDER.map((index) => (
                    <option key={index} value={index}>
                      {t(DAY_KEY[index])}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}

            <div className="tm-field">
              <label className="tm-field__label" htmlFor="tm-report-schedule-hour">
                {t('ReportSchedulesScreen.hourUtc')}
              </label>
              <input
                id="tm-report-schedule-hour"
                required
                {...check.control('tm-report-schedule-hour')}
                className="tm-field__control"
                type="number"
                min={0}
                max={23}
                value={hour}
                onChange={(event) => setHour(Number(event.target.value))}
              />
              <FormCheckMessage check={check} name="tm-report-schedule-hour" />
              <span className="tm-field__hint">{t('ReportSchedulesScreen.hourHint')}</span>
            </div>

            {save.isError ? (
              <InlineAlert tone="danger" title={t('ReportSchedulesScreen.createFailed')} live>
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
                loadingLabel={t('ReportSchedulesScreen.saving')}
              >
                {t('ReportSchedulesScreen.createSchedule')}
              </Button>
            </div>
          </form>
        </section>

        <section
          className="tm-panel tm-panel--quiet tm-stack"
          aria-labelledby="tm-report-schedule-list"
        >
          <h2 id="tm-report-schedule-list" className="tm-eyebrow">
            {t('ReportSchedulesScreen.yourSchedules')}
          </h2>

          {schedules.isError ? (
            <InlineAlert tone="danger" title={t('ReportSchedulesScreen.loadFailed')} live>
              {describeError(schedules.error)}
            </InlineAlert>
          ) : null}

          {remove.isError ? (
            <InlineAlert tone="danger" title={t('ReportSchedulesScreen.removeFailed')} live>
              {describeError(remove.error)}
            </InlineAlert>
          ) : null}

          {schedules.isPending ? (
            <LoadingRegion label={t('ReportSchedulesScreen.loading')}>
              <Skeleton height="var(--row)" />
              <Skeleton height="var(--row)" />
            </LoadingRegion>
          ) : null}

          {!schedules.isPending && !schedules.isError && rows.length === 0 ? (
            <TeachingEmptyState
              title={t('ReportSchedulesScreen.emptyTitle')}
              explanation={t('teachEmpty.reportSchedulesBody')}
              action={
                canUse('report.view') ? (
                  <Button
                    tone="lime"
                    size="accessible"
                    onClick={() => focusFirstField(firstStep.current)}
                  >
                    {t('teachEmpty.reportSchedulesAction')}
                  </Button>
                ) : undefined
              }
            />
          ) : null}

          {rows.length > 0 ? (
            <ul className="tm-list tm-stack">
              {rows.map((schedule) => (
                <li key={schedule.id} className="tm-row tm-row--wrap">
                  <div className="tm-stack tm-stack--tight">
                    <strong>{t(REPORT_KIND_KEY[schedule.reportKey])}</strong>
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
                    loadingLabel={t('ReportSchedulesScreen.removing')}
                    onClick={() => remove.mutate(schedule.id)}
                  >
                    {t('ReportSchedulesScreen.remove')}
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
        </section>

        <Announce message={save.isSuccess ? t('ReportSchedulesScreen.scheduleCreated') : ''} />
      </div>
    </AppShell>
  );
}

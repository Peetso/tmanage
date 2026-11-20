'use client';

import { useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import '../../styles/screens/insights.css';
import { browserApiClient } from '../../lib/api/browser-client';
import { fetchTargetStatus, setTarget } from '../../lib/api/insights-targets';
import type {
  MetricTargetMetric,
  MetricTargetPeriod,
  MetricTargetStatusView,
} from '../../lib/api/insights-targets';
import { useDescribeApiError } from '../../lib/api/describe-error';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';
import { FormCheckMessage, useFormCheck } from '../../lib/forms/form-check';
import { TeachingEmptyState, focusFirstField } from '../help/TeachingEmptyState';
import { useShellCapability } from '../shell/use-shell-capability';
import type { MessageKey } from '../../lib/i18n/t';

export interface InsightTargetsScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** Injected in tests. Defaults to the browser client. */
  client?: ApiClient;
}

/** The metrics a target can judge, in the order the picker shows them. */
const METRICS: readonly { id: MetricTargetMetric; labelKey: MessageKey }[] = [
  { id: 'open_items', labelKey: 'InsightTargetsScreen.metricOpenItems' },
  { id: 'scheduled_items', labelKey: 'InsightTargetsScreen.metricScheduledItems' },
  { id: 'active_projects', labelKey: 'InsightTargetsScreen.metricActiveProjects' },
  { id: 'active_assignees', labelKey: 'InsightTargetsScreen.metricActiveAssignees' },
];

/** The cadences a target can apply to, in the order the picker shows them. */
const PERIODS: readonly { id: MetricTargetPeriod; labelKey: MessageKey }[] = [
  { id: 'weekly', labelKey: 'InsightTargetsScreen.periodWeekly' },
  { id: 'monthly', labelKey: 'InsightTargetsScreen.periodMonthly' },
  { id: 'quarterly', labelKey: 'InsightTargetsScreen.periodQuarterly' },
];

/**
 * **Insight metric targets** — x230, module 15 (Insights & reporting). The audit's gap: insights are
 * reported and snapshotted, but there is no goal line to measure a live figure against. This screen
 * closes it — set an org-wide target per metric and see each live figure against its goal (on-track /
 * behind).
 *
 * The decisions are the sibling insights screens':
 * 1. **Authorization is the API's.** Setting a target needs `org.manage`; a viewer with `work.read`
 *    alone gets the API's 403, which `describe()` turns into a sentence in the form's own alert — the
 *    screen guesses no capability and hides no control.
 * 2. **No invented numbers.** The current value and attainment shown are exactly what the API's status
 *    read computed; the screen re-derives nothing.
 * 3. **No charts dependency.** A semantic table with a caption and row scope carries the status.
 */
export function InsightTargetsScreen({
  organizationSlug,
  organizationName,
  client,
}: InsightTargetsScreenProps) {
  const describe = useDescribeApiError();
  const api = client ?? browserApiClient();
  const queries = useQueryClient();
  const t = useT();
  const canUse = useShellCapability(organizationSlug, client);
  const firstStep = useRef<HTMLFormElement>(null);
  const [metric, setMetric] = useState<MetricTargetMetric>('open_items');
  const [period, setPeriod] = useState<MetricTargetPeriod>('weekly');
  const [value, setValue] = useState('10');

  const status = useQuery({
    queryKey: ['insight-targets-status', organizationSlug],
    queryFn: () => fetchTargetStatus(api, organizationSlug),
  });

  const save = useMutation({
    mutationFn: () =>
      setTarget(api, organizationSlug, { metric, targetValue: Number(value), period }),
    onSuccess: () => {
      void queries.invalidateQueries({ queryKey: ['insight-targets-status', organizationSlug] });
      void queries.invalidateQueries({ queryKey: ['insight-targets', organizationSlug] });
    },
  });

  const rows = status.data ?? [];

  // QA-FIX-S M2: the constraints in the markup are reported here, in the app's words.
  const check = useFormCheck();
  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="insights"
      eyebrow={t('InsightTargetsScreen.eyebrow')}
      title={t('InsightTargetsScreen.title')}
      description={t('InsightTargetsScreen.description')}
    >
      <div className="tm-ins tm-ins-tool">
        <section className="tm-panel tm-stack" aria-labelledby="tm-targets-heading">
          <h2 id="tm-targets-heading" className="tm-eyebrow">
            {t('InsightTargetsScreen.heading')}
          </h2>

          <form
            noValidate
            ref={firstStep}
            className="tm-row"
            {...check.handlers(() => save.mutate())}
          >
            <div className="tm-field">
              <label className="tm-field__label" htmlFor="tm-target-metric">
                {t('InsightTargetsScreen.metric')}
              </label>
              <select
                id="tm-target-metric"
                className="tm-field__control"
                value={metric}
                onChange={(event) => setMetric(event.target.value as MetricTargetMetric)}
              >
                {METRICS.map(({ id, labelKey }) => (
                  <option key={id} value={id}>
                    {t(labelKey)}
                  </option>
                ))}
              </select>
            </div>
            <div className="tm-field">
              <label className="tm-field__label" htmlFor="tm-target-value">
                {t('InsightTargetsScreen.target')}
              </label>
              <input
                id="tm-target-value"
                required
                {...check.control('tm-target-value')}
                className="tm-field__control"
                type="number"
                min={0}
                max={1000000}
                step={1}
                value={value}
                onChange={(event) => setValue(event.target.value)}
              />
              <FormCheckMessage check={check} name="tm-target-value" />
            </div>
            <div className="tm-field">
              <label className="tm-field__label" htmlFor="tm-target-period">
                {t('InsightTargetsScreen.period')}
              </label>
              <select
                id="tm-target-period"
                className="tm-field__control"
                value={period}
                onChange={(event) => setPeriod(event.target.value as MetricTargetPeriod)}
              >
                {PERIODS.map(({ id, labelKey }) => (
                  <option key={id} value={id}>
                    {t(labelKey)}
                  </option>
                ))}
              </select>
            </div>
            <Button
              type="submit"
              loading={save.isPending}
              loadingLabel={t('InsightTargetsScreen.savingTarget')}
            >
              {t('InsightTargetsScreen.setTarget')}
            </Button>
          </form>

          {save.isError ? (
            <InlineAlert tone="danger" title={t('InsightTargetsScreen.setErrorTitle')} live>
              {describe(save.error)}
            </InlineAlert>
          ) : null}

          {status.isPending ? (
            <LoadingRegion
              label={t('InsightTargetsScreen.loading')}
              className="tm-stack tm-stack--tight"
            >
              <Skeleton height="var(--row)" />
              <Skeleton height="var(--row)" />
            </LoadingRegion>
          ) : null}

          {status.isError ? (
            <InlineAlert tone="danger" title={t('InsightTargetsScreen.loadErrorTitle')} live>
              {describe(status.error)}
            </InlineAlert>
          ) : null}

          {status.isSuccess ? (
            <TargetStatusTable
              rows={rows}
              action={
                canUse('org.manage') ? (
                  <Button
                    tone="lime"
                    size="accessible"
                    onClick={() => focusFirstField(firstStep.current)}
                  >
                    {t('teachEmpty.insightTargetsAction')}
                  </Button>
                ) : undefined
              }
            />
          ) : null}
        </section>
      </div>
    </AppShell>
  );
}

function TargetStatusTable({
  rows,
  action,
}: {
  readonly rows: readonly MetricTargetStatusView[];
  /** The teaching state's one action, when the role may set a target. */
  readonly action?: ReactNode;
}) {
  const t = useT();
  if (rows.length === 0) {
    return (
      <TeachingEmptyState
        title={t('teachEmpty.insightTargetsTitle')}
        explanation={t('teachEmpty.insightTargetsBody')}
        action={action}
      />
    );
  }

  return (
    <table className="tm-table">
      <caption className="tm-visually-hidden">{t('InsightTargetsScreen.tableCaption')}</caption>
      <thead>
        <tr>
          <th scope="col">{t('InsightTargetsScreen.colMetric')}</th>
          <th scope="col">{t('InsightTargetsScreen.colCurrent')}</th>
          <th scope="col">{t('InsightTargetsScreen.colTarget')}</th>
          <th scope="col">{t('InsightTargetsScreen.colPeriod')}</th>
          <th scope="col">{t('InsightTargetsScreen.colAttainment')}</th>
          <th scope="col">{t('InsightTargetsScreen.colStatus')}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.metric}>
            <th scope="row">{t(metricLabelKey(row.metric))}</th>
            <td className="tm-mono">{row.currentValue}</td>
            <td className="tm-mono">{row.targetValue}</td>
            <td>{t(periodLabelKey(row.period))}</td>
            <td className="tm-mono">{formatAttainment(row.attainment)}</td>
            <td>
              <Badge mono>
                {row.status === 'on_track'
                  ? t('InsightTargetsScreen.onTrack')
                  : t('InsightTargetsScreen.behind')}
              </Badge>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Turn an ISO metric key into its label message key; falls back to the open-items label. */
function metricLabelKey(metric: MetricTargetMetric): MessageKey {
  return METRICS.find((m) => m.id === metric)?.labelKey ?? METRICS[0]!.labelKey;
}

function periodLabelKey(period: MetricTargetPeriod): MessageKey {
  return PERIODS.find((p) => p.id === period)?.labelKey ?? PERIODS[0]!.labelKey;
}

/** A null attainment (zero target) shows as an em dash, never a divide error. */
function formatAttainment(attainment: number | null): string {
  if (attainment === null) return '—';
  return `${Math.round(attainment * 100)}%`;
}

'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import '../../styles/screens/insights.css';
import { browserApiClient } from '../../lib/api/browser-client';
import { deleteAlert, listAlerts, setAlert } from '../../lib/api/insights-metric-alerts';
import type {
  MetricAlertComparator,
  MetricAlertMetric,
  MetricAlertStatusView,
} from '../../lib/api/insights-metric-alerts';
import { useDescribeApiError } from '../../lib/api/describe-error';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';
import { TeachingEmptyState } from '../help/TeachingEmptyState';
import type { MessageKey } from '../../lib/i18n/t';

export interface InsightMetricAlertsScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** Injected in tests. Defaults to the browser client. */
  client?: ApiClient;
}

/** The metrics an alert can watch, in the order the picker shows them. */
const METRICS: readonly { id: MetricAlertMetric; labelKey: MessageKey }[] = [
  { id: 'open_items', labelKey: 'InsightMetricAlertsScreen.metricOpenItems' },
  { id: 'scheduled_items', labelKey: 'InsightMetricAlertsScreen.metricScheduledItems' },
  { id: 'active_projects', labelKey: 'InsightMetricAlertsScreen.metricActiveProjects' },
  { id: 'active_assignees', labelKey: 'InsightMetricAlertsScreen.metricActiveAssignees' },
];

/** The comparators an alert can apply, in the order the picker shows them. */
const COMPARATORS: readonly { id: MetricAlertComparator; labelKey: MessageKey }[] = [
  { id: 'gte', labelKey: 'InsightMetricAlertsScreen.comparatorGte' },
  { id: 'lte', labelKey: 'InsightMetricAlertsScreen.comparatorLte' },
];

/**
 * **Insight metric alerts** — x319, module 15 (Insights & reporting). The audit's gap: insights are
 * reported, snapshotted, compared and given org-wide targets, but a member has no personal threshold
 * alert. This screen closes it — set your own alert per metric (a comparator and a threshold) and see
 * each one marked breached or ok against the latest workload snapshot. Config + read-side evaluation
 * only; no dispatch this slice.
 *
 * The decisions are the sibling insights screens':
 * 1. **Authorization is the API's.** Every route is `work.read` and self-scoped; a client gets the
 *    API's 403, which `describe()` turns into a sentence in the form's own alert.
 * 2. **No invented numbers.** The current value and breach shown are exactly what the API's read
 *    computed against the latest snapshot; the screen re-derives nothing. A null current value (no
 *    snapshot yet) shows as an em dash.
 * 3. **No charts dependency.** A semantic table with a caption and row scope carries the status.
 */
export function InsightMetricAlertsScreen({
  organizationSlug,
  organizationName,
  client,
}: InsightMetricAlertsScreenProps) {
  const describe = useDescribeApiError();
  const api = client ?? browserApiClient();
  const queries = useQueryClient();
  const t = useT();
  const [metricKey, setMetricKey] = useState<MetricAlertMetric>('open_items');
  const [comparator, setComparator] = useState<MetricAlertComparator>('gte');
  const [threshold, setThreshold] = useState('10');

  const alerts = useQuery({
    queryKey: ['insight-metric-alerts', organizationSlug],
    queryFn: () => listAlerts(api, organizationSlug),
  });

  const invalidate = () =>
    queries.invalidateQueries({ queryKey: ['insight-metric-alerts', organizationSlug] });

  const save = useMutation({
    mutationFn: () =>
      setAlert(api, organizationSlug, { metricKey, comparator, threshold: Number(threshold) }),
    onSuccess: () => void invalidate(),
  });

  const remove = useMutation({
    mutationFn: (metric: MetricAlertMetric) => deleteAlert(api, organizationSlug, metric),
    onSuccess: () => void invalidate(),
  });

  const rows = alerts.data ?? [];

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="insights"
      eyebrow={t('InsightMetricAlertsScreen.eyebrow')}
      title={t('InsightMetricAlertsScreen.title')}
      description={t('InsightMetricAlertsScreen.description')}
    >
      <div className="tm-ins tm-ins-tool">
        <section className="tm-panel tm-stack" aria-labelledby="tm-metric-alerts-heading">
          <h2 id="tm-metric-alerts-heading" className="tm-eyebrow">
            {t('InsightMetricAlertsScreen.heading')}
          </h2>

          <form
            className="tm-row"
            onSubmit={(event) => {
              event.preventDefault();
              save.mutate();
            }}
          >
            <div className="tm-field">
              <label className="tm-field__label" htmlFor="tm-alert-metric">
                {t('InsightMetricAlertsScreen.metric')}
              </label>
              <select
                id="tm-alert-metric"
                className="tm-field__control"
                value={metricKey}
                onChange={(event) => setMetricKey(event.target.value as MetricAlertMetric)}
              >
                {METRICS.map(({ id, labelKey }) => (
                  <option key={id} value={id}>
                    {t(labelKey)}
                  </option>
                ))}
              </select>
            </div>
            <div className="tm-field">
              <label className="tm-field__label" htmlFor="tm-alert-comparator">
                {t('InsightMetricAlertsScreen.comparator')}
              </label>
              <select
                id="tm-alert-comparator"
                className="tm-field__control"
                value={comparator}
                onChange={(event) => setComparator(event.target.value as MetricAlertComparator)}
              >
                {COMPARATORS.map(({ id, labelKey }) => (
                  <option key={id} value={id}>
                    {t(labelKey)}
                  </option>
                ))}
              </select>
            </div>
            <div className="tm-field">
              <label className="tm-field__label" htmlFor="tm-alert-threshold">
                {t('InsightMetricAlertsScreen.threshold')}
              </label>
              <input
                id="tm-alert-threshold"
                className="tm-field__control"
                type="number"
                min={0}
                max={1000000}
                step={1}
                value={threshold}
                onChange={(event) => setThreshold(event.target.value)}
              />
            </div>
            <Button
              type="submit"
              loading={save.isPending}
              loadingLabel={t('InsightMetricAlertsScreen.savingAlert')}
            >
              {t('InsightMetricAlertsScreen.setAlert')}
            </Button>
          </form>

          {save.isError ? (
            <InlineAlert tone="danger" title={t('InsightMetricAlertsScreen.setErrorTitle')} live>
              {describe(save.error)}
            </InlineAlert>
          ) : null}

          {remove.isError ? (
            <InlineAlert tone="danger" title={t('InsightMetricAlertsScreen.deleteErrorTitle')} live>
              {describe(remove.error)}
            </InlineAlert>
          ) : null}

          {alerts.isPending ? (
            <LoadingRegion
              label={t('InsightMetricAlertsScreen.loading')}
              className="tm-stack tm-stack--tight"
            >
              <Skeleton height="var(--row)" />
              <Skeleton height="var(--row)" />
            </LoadingRegion>
          ) : null}

          {alerts.isError ? (
            <InlineAlert tone="danger" title={t('InsightMetricAlertsScreen.loadErrorTitle')} live>
              {describe(alerts.error)}
            </InlineAlert>
          ) : null}

          {alerts.isSuccess ? (
            <AlertsTable
              rows={rows}
              onDelete={(metric) => remove.mutate(metric)}
              busy={remove.isPending}
            />
          ) : null}
        </section>
      </div>
    </AppShell>
  );
}

function AlertsTable({
  rows,
  onDelete,
  busy,
}: {
  rows: readonly MetricAlertStatusView[];
  onDelete: (metric: MetricAlertMetric) => void;
  busy: boolean;
}) {
  const t = useT();
  if (rows.length === 0) {
    return (
      <TeachingEmptyState
        title={t('teachEmpty.metricAlertsTitle')}
        explanation={t('teachEmpty.metricAlertsBody')}
      />
    );
  }

  return (
    <table className="tm-table">
      <caption className="tm-visually-hidden">
        {t('InsightMetricAlertsScreen.tableCaption')}
      </caption>
      <thead>
        <tr>
          <th scope="col">{t('InsightMetricAlertsScreen.colMetric')}</th>
          <th scope="col">{t('InsightMetricAlertsScreen.colCondition')}</th>
          <th scope="col">{t('InsightMetricAlertsScreen.colCurrent')}</th>
          <th scope="col">{t('InsightMetricAlertsScreen.colStatus')}</th>
          <th scope="col">
            <span className="tm-visually-hidden">{t('InsightMetricAlertsScreen.colActions')}</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.metricKey}>
            <th scope="row">{t(metricLabelKey(row.metricKey))}</th>
            <td>
              {t(comparatorLabelKey(row.comparator))}{' '}
              <span className="tm-mono">{row.threshold}</span>
            </td>
            <td className="tm-mono">{row.currentValue === null ? '—' : row.currentValue}</td>
            <td>
              <Badge mono>
                {row.breached
                  ? t('InsightMetricAlertsScreen.breached')
                  : t('InsightMetricAlertsScreen.ok')}
              </Badge>
            </td>
            <td>
              <Button tone="text" onClick={() => onDelete(row.metricKey)} disabled={busy}>
                {t('InsightMetricAlertsScreen.delete')}
              </Button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Turn an ISO metric key into its label message key; falls back to the open-items label. */
function metricLabelKey(metric: MetricAlertMetric): MessageKey {
  return METRICS.find((m) => m.id === metric)?.labelKey ?? METRICS[0]!.labelKey;
}

function comparatorLabelKey(comparator: MetricAlertComparator): MessageKey {
  return COMPARATORS.find((c) => c.id === comparator)?.labelKey ?? COMPARATORS[0]!.labelKey;
}

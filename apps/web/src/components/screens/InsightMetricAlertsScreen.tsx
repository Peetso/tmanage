'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { deleteAlert, listAlerts, setAlert } from '../../lib/api/insights-metric-alerts';
import type {
  MetricAlertComparator,
  MetricAlertMetric,
  MetricAlertStatusView,
} from '../../lib/api/insights-metric-alerts';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface InsightMetricAlertsScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** Injected in tests. Defaults to the browser client. */
  client?: ApiClient;
}

/** The metrics an alert can watch, in the order the picker shows them. */
const METRICS: readonly { id: MetricAlertMetric; label: string }[] = [
  { id: 'open_items', label: 'Open items' },
  { id: 'scheduled_items', label: 'Scheduled items' },
  { id: 'active_projects', label: 'Active projects' },
  { id: 'active_assignees', label: 'Active assignees' },
];

/** The comparators an alert can apply, in the order the picker shows them. */
const COMPARATORS: readonly { id: MetricAlertComparator; label: string }[] = [
  { id: 'gte', label: 'At or above (≥)' },
  { id: 'lte', label: 'At or below (≤)' },
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
  const api = client ?? browserApiClient();
  const queries = useQueryClient();
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
      title="Metric alerts"
      description="Set your own threshold alert per metric and see which are breached right now."
    >
      <section className="tm-panel tm-stack" aria-labelledby="tm-metric-alerts-heading">
        <h2 id="tm-metric-alerts-heading" className="tm-eyebrow">
          Metric alerts
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
              Metric
            </label>
            <select
              id="tm-alert-metric"
              className="tm-field__control"
              value={metricKey}
              onChange={(event) => setMetricKey(event.target.value as MetricAlertMetric)}
            >
              {METRICS.map(({ id, label }) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <div className="tm-field">
            <label className="tm-field__label" htmlFor="tm-alert-comparator">
              Comparator
            </label>
            <select
              id="tm-alert-comparator"
              className="tm-field__control"
              value={comparator}
              onChange={(event) => setComparator(event.target.value as MetricAlertComparator)}
            >
              {COMPARATORS.map(({ id, label }) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <div className="tm-field">
            <label className="tm-field__label" htmlFor="tm-alert-threshold">
              Threshold
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
          <Button type="submit" loading={save.isPending} loadingLabel="Saving the alert">
            Set alert
          </Button>
        </form>

        {save.isError ? (
          <InlineAlert tone="danger" title="Could not set the alert" live>
            {describe(save.error)}
          </InlineAlert>
        ) : null}

        {remove.isError ? (
          <InlineAlert tone="danger" title="Could not delete the alert" live>
            {describe(remove.error)}
          </InlineAlert>
        ) : null}

        {alerts.isPending ? (
          <LoadingRegion label="Loading your metric alerts." className="tm-stack tm-stack--tight">
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {alerts.isError ? (
          <InlineAlert tone="danger" title="Could not load metric alerts" live>
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
  if (rows.length === 0) {
    return <p className="tm-prose">No alerts yet. Set one above to start watching a metric.</p>;
  }

  return (
    <table className="tm-table">
      <caption className="tm-visually-hidden">
        Your metric alerts and whether each is breached
      </caption>
      <thead>
        <tr>
          <th scope="col">Metric</th>
          <th scope="col">Condition</th>
          <th scope="col">Current</th>
          <th scope="col">Status</th>
          <th scope="col">
            <span className="tm-visually-hidden">Actions</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.metricKey}>
            <th scope="row">{metricLabel(row.metricKey)}</th>
            <td>
              {comparatorLabel(row.comparator)} <span className="tm-mono">{row.threshold}</span>
            </td>
            <td className="tm-mono">{row.currentValue === null ? '—' : row.currentValue}</td>
            <td>
              <Badge mono>{row.breached ? 'Breached' : 'OK'}</Badge>
            </td>
            <td>
              <Button tone="text" onClick={() => onDelete(row.metricKey)} disabled={busy}>
                Delete
              </Button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Turn an ISO metric key into its display label; falls back to the key. */
function metricLabel(metric: MetricAlertMetric): string {
  return METRICS.find((m) => m.id === metric)?.label ?? metric;
}

function comparatorLabel(comparator: MetricAlertComparator): string {
  return COMPARATORS.find((c) => c.id === comparator)?.label ?? comparator;
}

/** Turn a thrown value into a sentence a person can act on. Never leaks a stack or a cause. */
function describe(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Check that it is running.';
  return 'Something went wrong. Try again.';
}

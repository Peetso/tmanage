'use client';

import { useState } from 'react';
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
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface InsightTargetsScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** Injected in tests. Defaults to the browser client. */
  client?: ApiClient;
}

/** The metrics a target can judge, in the order the picker shows them. */
const METRICS: readonly { id: MetricTargetMetric; label: string }[] = [
  { id: 'open_items', label: 'Open items' },
  { id: 'scheduled_items', label: 'Scheduled items' },
  { id: 'active_projects', label: 'Active projects' },
  { id: 'active_assignees', label: 'Active assignees' },
];

/** The cadences a target can apply to, in the order the picker shows them. */
const PERIODS: readonly { id: MetricTargetPeriod; label: string }[] = [
  { id: 'weekly', label: 'Weekly' },
  { id: 'monthly', label: 'Monthly' },
  { id: 'quarterly', label: 'Quarterly' },
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
  const api = client ?? browserApiClient();
  const queries = useQueryClient();
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

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="insights"
      eyebrow="Insights"
      title="Insight targets"
      description="Set an org-wide goal per metric and measure the live figure against it."
    >
      <div className="tm-ins tm-ins-tool">
        <section className="tm-panel tm-stack" aria-labelledby="tm-targets-heading">
          <h2 id="tm-targets-heading" className="tm-eyebrow">
            Insight targets
          </h2>

          <form
            className="tm-row"
            onSubmit={(event) => {
              event.preventDefault();
              save.mutate();
            }}
          >
            <div className="tm-field">
              <label className="tm-field__label" htmlFor="tm-target-metric">
                Metric
              </label>
              <select
                id="tm-target-metric"
                className="tm-field__control"
                value={metric}
                onChange={(event) => setMetric(event.target.value as MetricTargetMetric)}
              >
                {METRICS.map(({ id, label }) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            <div className="tm-field">
              <label className="tm-field__label" htmlFor="tm-target-value">
                Target
              </label>
              <input
                id="tm-target-value"
                className="tm-field__control"
                type="number"
                min={0}
                max={1000000}
                step={1}
                value={value}
                onChange={(event) => setValue(event.target.value)}
              />
            </div>
            <div className="tm-field">
              <label className="tm-field__label" htmlFor="tm-target-period">
                Period
              </label>
              <select
                id="tm-target-period"
                className="tm-field__control"
                value={period}
                onChange={(event) => setPeriod(event.target.value as MetricTargetPeriod)}
              >
                {PERIODS.map(({ id, label }) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            <Button type="submit" loading={save.isPending} loadingLabel="Saving the target">
              Set target
            </Button>
          </form>

          {save.isError ? (
            <InlineAlert tone="danger" title="Could not set the target" live>
              {describe(save.error)}
            </InlineAlert>
          ) : null}

          {status.isPending ? (
            <LoadingRegion label="Loading target status." className="tm-stack tm-stack--tight">
              <Skeleton height="var(--row)" />
              <Skeleton height="var(--row)" />
            </LoadingRegion>
          ) : null}

          {status.isError ? (
            <InlineAlert tone="danger" title="Could not load target status" live>
              {describe(status.error)}
            </InlineAlert>
          ) : null}

          {status.isSuccess ? <TargetStatusTable rows={rows} /> : null}
        </section>
      </div>
    </AppShell>
  );
}

function TargetStatusTable({ rows }: { rows: readonly MetricTargetStatusView[] }) {
  if (rows.length === 0) {
    return (
      <p className="tm-prose">No targets set yet. Set one above to start measuring against it.</p>
    );
  }

  return (
    <table className="tm-table">
      <caption className="tm-visually-hidden">Metric targets and their current attainment</caption>
      <thead>
        <tr>
          <th scope="col">Metric</th>
          <th scope="col">Current</th>
          <th scope="col">Target</th>
          <th scope="col">Period</th>
          <th scope="col">Attainment</th>
          <th scope="col">Status</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.metric}>
            <th scope="row">{metricLabel(row.metric)}</th>
            <td className="tm-mono">{row.currentValue}</td>
            <td className="tm-mono">{row.targetValue}</td>
            <td>{periodLabel(row.period)}</td>
            <td className="tm-mono">{formatAttainment(row.attainment)}</td>
            <td>
              <Badge mono>{row.status === 'on_track' ? 'On track' : 'Behind'}</Badge>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Turn an ISO metric key into its display label; falls back to the key. */
function metricLabel(metric: MetricTargetMetric): string {
  return METRICS.find((m) => m.id === metric)?.label ?? metric;
}

function periodLabel(period: MetricTargetPeriod): string {
  return PERIODS.find((p) => p.id === period)?.label ?? period;
}

/** A null attainment (zero target) shows as an em dash, never a divide error. */
function formatAttainment(attainment: number | null): string {
  if (attainment === null) return '—';
  return `${Math.round(attainment * 100)}%`;
}

/** Turn a thrown value into a sentence a person can act on. Never leaks a stack or a cause. */
function describe(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Check that it is running.';
  return 'Something went wrong. Try again.';
}

'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Announce, Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  INSIGHT_CUSTOM_REPORT_LAYOUTS,
  INSIGHT_CUSTOM_REPORT_METRICS,
  createInsightCustomReport,
  deleteInsightCustomReport,
  getInsightCustomReport,
  listInsightCustomReports,
} from '../../lib/api/insight-custom-reports';
import type {
  InsightCustomReportLayout,
  InsightCustomReportMetric,
} from '../../lib/api/insight-custom-reports';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface InsightCustomReportsViewProps {
  organizationSlug: string;
  organizationName: string;
  /** Injected in tests. Defaults to the browser client. */
  client?: ApiClient;
}

const METRIC_LABELS: Readonly<Record<InsightCustomReportMetric, string>> = {
  open_items: 'Open items',
  scheduled_items: 'Scheduled items',
  active_projects: 'Active projects',
  active_assignees: 'Active assignees',
};

const LAYOUT_LABELS: Readonly<Record<InsightCustomReportLayout, string>> = {
  list: 'List',
  grid: 'Grid',
};

/**
 * **Custom insight reports** (module 15, x320).
 *
 * `38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP` §Insights & reporting (custom reports); `22-SCREEN`
 * §Insights: the insights reads exist, but a person cannot compose an arbitrary set of metrics into one
 * named report. This screen is that builder — a form to name a report, pick an ordered selection of
 * metric keys and a layout, the list of the caller's own reports, a "Render" action that reads the
 * report back with its metrics resolved to current figures, and a "Remove" action.
 *
 * The decisions are the sibling insights screens':
 * 1. **Authorization is the API's.** Every route sits behind `work.read`; a caller without it sees the
 *    API's 403 turned into a sentence in the panel's alert, never a blank page.
 * 2. **Private to the owner.** The list is only ever the caller's own reports (the API scopes by
 *    owner), and a rendered/removed report is one the caller owns — an id that is not the caller's
 *    answers 404.
 * 3. **Composition, rendered read-only.** The report stores an ordered metric selection; the render is
 *    the API's composition over the existing insights reads, so the screen shows live figures without
 *    computing any metric itself.
 */
export function InsightCustomReportsView({
  organizationSlug,
  organizationName,
  client,
}: InsightCustomReportsViewProps) {
  const api = client ?? browserApiClient();
  const queries = useQueryClient();
  const listKey = ['insight-custom-reports', organizationSlug] as const;

  const [name, setName] = useState('');
  const [metricKeys, setMetricKeys] = useState<readonly InsightCustomReportMetric[]>([]);
  const [layout, setLayout] = useState<InsightCustomReportLayout>('list');
  const [renderId, setRenderId] = useState<string | null>(null);

  const reports = useQuery({
    queryKey: listKey,
    queryFn: () => listInsightCustomReports(api, organizationSlug),
  });

  const rendered = useQuery({
    queryKey: ['insight-custom-report', organizationSlug, renderId] as const,
    queryFn: () => getInsightCustomReport(api, organizationSlug, renderId as string),
    enabled: renderId !== null,
  });

  const save = useMutation({
    mutationFn: () =>
      createInsightCustomReport(api, organizationSlug, { name: name.trim(), metricKeys, layout }),
    onSuccess: () => {
      void queries.invalidateQueries({ queryKey: listKey });
      setName('');
      setMetricKeys([]);
      setLayout('list');
    },
  });

  const remove = useMutation({
    mutationFn: (reportId: string) => deleteInsightCustomReport(api, organizationSlug, reportId),
    onSuccess: (_result, reportId) => {
      void queries.invalidateQueries({ queryKey: listKey });
      if (renderId === reportId) setRenderId(null);
    },
  });

  const rows = reports.data ?? [];
  const canSave = name.trim() !== '' && metricKeys.length > 0 && !save.isPending;

  function toggleMetric(metric: InsightCustomReportMetric): void {
    setMetricKeys((current) =>
      current.includes(metric) ? current.filter((key) => key !== metric) : [...current, metric],
    );
  }

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="insights"
      title="Custom insight reports"
      description="Compose the metrics you care about into a named report and render it against today’s numbers."
    >
      <section className="tm-panel tm-stack" aria-labelledby="tm-custom-report-editor">
        <h2 id="tm-custom-report-editor" className="tm-eyebrow">
          New custom report
        </h2>

        <form
          className="tm-stack"
          onSubmit={(event) => {
            event.preventDefault();
            if (canSave) save.mutate();
          }}
        >
          <div className="tm-field">
            <label className="tm-field__label" htmlFor="tm-custom-report-name">
              Name
            </label>
            <input
              id="tm-custom-report-name"
              className="tm-field__control"
              value={name}
              maxLength={300}
              required
              onChange={(event) => setName(event.target.value)}
            />
          </div>

          <fieldset className="tm-field">
            <legend className="tm-field__label">Metrics</legend>
            <div className="tm-stack tm-stack--tight">
              {INSIGHT_CUSTOM_REPORT_METRICS.map((metric) => (
                <label key={metric} className="tm-row tm-row--tight">
                  <input
                    type="checkbox"
                    checked={metricKeys.includes(metric)}
                    onChange={() => toggleMetric(metric)}
                  />
                  <span>{METRIC_LABELS[metric]}</span>
                </label>
              ))}
            </div>
            <span className="tm-field__hint">
              Pick one or more metrics. The report renders them in the order you add them.
            </span>
          </fieldset>

          <div className="tm-field">
            <label className="tm-field__label" htmlFor="tm-custom-report-layout">
              Layout
            </label>
            <select
              id="tm-custom-report-layout"
              className="tm-field__control"
              value={layout}
              onChange={(event) => setLayout(event.target.value as InsightCustomReportLayout)}
            >
              {INSIGHT_CUSTOM_REPORT_LAYOUTS.map((option) => (
                <option key={option} value={option}>
                  {LAYOUT_LABELS[option]}
                </option>
              ))}
            </select>
          </div>

          {save.isError ? (
            <InlineAlert tone="danger" title="Could not save the report" live>
              {describeError(save.error)}
            </InlineAlert>
          ) : null}

          <div className="tm-row">
            <Button
              type="submit"
              tone="ink"
              size="accessible"
              disabled={!canSave}
              loading={save.isPending}
              loadingLabel="Saving"
            >
              Save report
            </Button>
          </div>
        </form>
      </section>

      <section
        className="tm-panel tm-panel--quiet tm-stack"
        aria-labelledby="tm-custom-report-list"
      >
        <h2 id="tm-custom-report-list" className="tm-eyebrow">
          Your custom reports
        </h2>

        {reports.isError ? (
          <InlineAlert tone="danger" title="Could not load your reports" live>
            {describeError(reports.error)}
          </InlineAlert>
        ) : null}

        {remove.isError ? (
          <InlineAlert tone="danger" title="Could not remove the report" live>
            {describeError(remove.error)}
          </InlineAlert>
        ) : null}

        {reports.isPending ? (
          <LoadingRegion label="Loading your reports.">
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {!reports.isPending && !reports.isError && rows.length === 0 ? (
          <InlineAlert tone="neutral" title="No custom reports yet">
            Compose a report above and it will appear here for you to render.
          </InlineAlert>
        ) : null}

        {rows.length > 0 ? (
          <ul className="tm-list tm-stack">
            {rows.map((report) => (
              <li key={report.id} className="tm-row tm-row--wrap">
                <div className="tm-stack tm-stack--tight">
                  <strong>{report.name}</strong>
                  <span className="tm-field__hint">
                    {LAYOUT_LABELS[report.layout]} ·{' '}
                    {report.metricKeys.map((metric) => METRIC_LABELS[metric]).join(', ')}
                  </span>
                </div>
                <div className="tm-row tm-row--tight">
                  <Button
                    tone="ink"
                    size="accessible"
                    loading={rendered.isFetching && renderId === report.id}
                    loadingLabel="Rendering"
                    onClick={() => setRenderId(report.id)}
                  >
                    Render
                  </Button>
                  <Button
                    tone="outline"
                    size="accessible"
                    loading={remove.isPending && remove.variables === report.id}
                    loadingLabel="Removing"
                    onClick={() => remove.mutate(report.id)}
                  >
                    Remove
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      {renderId !== null ? (
        <section className="tm-panel tm-stack" aria-labelledby="tm-custom-report-rendered">
          <h2 id="tm-custom-report-rendered" className="tm-eyebrow">
            Rendered report
          </h2>

          {rendered.isError ? (
            <InlineAlert tone="danger" title="Could not render the report" live>
              {describeError(rendered.error)}
            </InlineAlert>
          ) : null}

          {rendered.isPending ? (
            <LoadingRegion label="Rendering the report.">
              <Skeleton height="var(--row)" />
            </LoadingRegion>
          ) : null}

          {rendered.data ? (
            <>
              <strong>{rendered.data.report.name}</strong>
              <ul className="tm-list tm-stack tm-stack--tight">
                {rendered.data.metrics.map((entry) => (
                  <li key={entry.metric} className="tm-row tm-row--wrap">
                    <span>{METRIC_LABELS[entry.metric]}</span>
                    <strong>{entry.value}</strong>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </section>
      ) : null}

      <Announce message={save.isSuccess ? 'Custom report stored.' : ''} />
    </AppShell>
  );
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}

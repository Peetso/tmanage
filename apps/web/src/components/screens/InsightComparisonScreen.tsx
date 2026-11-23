'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button, DateField, InlineAlert, LoadingRegion, Select, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import '../../styles/screens/insights.css';
import { browserApiClient } from '../../lib/api/browser-client';
import { fetchPeriodComparison } from '../../lib/api/insights-comparison';
import type { ComparisonMetric, PeriodComparisonView } from '../../lib/api/insights-comparison';
import { useDescribeApiError } from '../../lib/api/describe-error';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';
import type { MessageKey } from '../../lib/i18n/t';
import { appIntlLocale } from '../../lib/i18n/app-locale';

type Translate = (key: MessageKey) => string;

export interface InsightComparisonScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** Injected in tests. Defaults to the browser client. */
  client?: ApiClient;
}

/** The metrics the API accepts, listed for the selector — the exact server allowlist. */
const METRIC_OPTIONS: readonly { value: ComparisonMetric; labelKey: MessageKey }[] = [
  { value: 'work_items_created', labelKey: 'InsightComparisonScreen.metricWorkItems' },
  { value: 'meetings_held', labelKey: 'InsightComparisonScreen.metricMeetings' },
];

/** A calendar day (`YYYY-MM-DD`) as an inclusive-start / exclusive-end ISO instant. */
function dayToInstant(day: string): string {
  return `${day}T00:00:00.000Z`;
}

/** Compose the API's `start..end` window from two calendar days. */
function windowParam(start: string, end: string): string {
  return `${dayToInstant(start)}..${dayToInstant(end)}`;
}

/** `YYYY-MM-DD` for a date, in UTC — the dialect `<input type="date">` speaks. */
function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** The default windows: the previous full month (A) beside the current month to date (B). */
function defaultDays(): { aStart: string; aEnd: string; bStart: string; bEnd: string } {
  const now = new Date();
  const thisMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const lastMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const tomorrow = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
  );
  return {
    aStart: isoDay(lastMonthStart),
    aEnd: isoDay(thisMonthStart),
    bStart: isoDay(thisMonthStart),
    bEnd: isoDay(tomorrow),
  };
}

/**
 * **Period comparison** — x229, module 15's period-over-period read turned into a proven screen. It
 * reads `GET /v1/organizations/:orgSlug/insights/compare` (gated on the server by `work.read`) and
 * shows one metric's count over two windows side by side, with the difference and the percentage
 * change.
 *
 * The decisions are the sibling insights screens':
 * 1. **Authorization is the API's.** A caller without `work.read` gets the ordinary 403, which
 *    `describe()` turns into a sentence in the panel's own alert; the screen never guesses a
 *    capability of its own.
 * 2. **The metric selector offers only allowlisted values**, and the windows are two calendar
 *    ranges — so a request is always a metric the server honours and a window it can parse; a base
 *    of zero shows "n/a" for the percentage rather than a fabricated number (the server sends
 *    `null`).
 * 3. **No invented numbers.** The counts, the delta and the percentage are the API's.
 */
export function InsightComparisonScreen({
  organizationSlug,
  organizationName,
  client,
}: InsightComparisonScreenProps) {
  const describe = useDescribeApiError();
  const t = useT();
  const api = client ?? browserApiClient();
  const defaults = defaultDays();

  const [metric, setMetric] = useState<ComparisonMetric>('work_items_created');
  const [aStart, setAStart] = useState(defaults.aStart);
  const [aEnd, setAEnd] = useState(defaults.aEnd);
  const [bStart, setBStart] = useState(defaults.bStart);
  const [bEnd, setBEnd] = useState(defaults.bEnd);

  const [submitted, setSubmitted] = useState({
    metric,
    periodA: windowParam(aStart, aEnd),
    periodB: windowParam(bStart, bEnd),
  });

  const comparison = useQuery({
    queryKey: ['insights-comparison', organizationSlug, submitted],
    queryFn: () => fetchPeriodComparison(api, organizationSlug, submitted),
  });

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="insights"
      eyebrow={t('InsightComparisonScreen.eyebrow')}
      title={t('InsightComparisonScreen.title')}
      description={t('InsightComparisonScreen.description')}
    >
      <div className="tm-ins tm-ins-tool">
        <section className="tm-panel tm-stack" aria-labelledby="tm-compare-heading">
          <h2 id="tm-compare-heading" className="tm-eyebrow">
            {t('InsightComparisonScreen.heading')}
          </h2>

          <form
            noValidate
            className="tm-stack tm-stack--tight"
            onSubmit={(event) => {
              event.preventDefault();
              setSubmitted({
                metric,
                periodA: windowParam(aStart, aEnd),
                periodB: windowParam(bStart, bEnd),
              });
            }}
          >
            <Select
              label={t('InsightComparisonScreen.metricLabel')}
              value={metric}
              onChange={(event) => setMetric(event.currentTarget.value as ComparisonMetric)}
            >
              {METRIC_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {t(option.labelKey)}
                </option>
              ))}
            </Select>

            <DateField
              label={t('InsightComparisonScreen.periodAStart')}
              value={aStart}
              onValueChange={setAStart}
            />
            <DateField
              label={t('InsightComparisonScreen.periodAEnd')}
              value={aEnd}
              onValueChange={setAEnd}
            />
            <DateField
              label={t('InsightComparisonScreen.periodBStart')}
              value={bStart}
              onValueChange={setBStart}
            />
            <DateField
              label={t('InsightComparisonScreen.periodBEnd')}
              value={bEnd}
              onValueChange={setBEnd}
            />

            <Button type="submit">{t('InsightComparisonScreen.compare')}</Button>
          </form>

          {comparison.isPending ? (
            <LoadingRegion
              label={t('InsightComparisonScreen.loading')}
              className="tm-stack tm-stack--tight"
            >
              <Skeleton height="var(--row)" />
              <Skeleton height="var(--row)" />
            </LoadingRegion>
          ) : null}

          {comparison.isError ? (
            <InlineAlert tone="danger" title={t('InsightComparisonScreen.loadErrorTitle')} live>
              {describe(comparison.error)}
            </InlineAlert>
          ) : null}

          {comparison.isSuccess ? <ComparisonCards comparison={comparison.data} t={t} /> : null}
        </section>
      </div>
    </AppShell>
  );
}

function ComparisonCards({ comparison, t }: { comparison: PeriodComparisonView; t: Translate }) {
  const { a, b, delta, pct } = comparison;
  return (
    <div className="tm-stack tm-stack--tight" aria-live="polite">
      <dl className="tm-row">
        <Metric
          label={`${t('InsightComparisonScreen.periodA')} (${windowCaption(a.start, a.end, t)})`}
          value={a.value}
        />
        <Metric
          label={`${t('InsightComparisonScreen.periodB')} (${windowCaption(b.start, b.end, t)})`}
          value={b.value}
        />
        <Metric label={t('InsightComparisonScreen.change')} value={formatDelta(delta)} />
        <Metric
          label={t('InsightComparisonScreen.percentChange')}
          value={pct === null ? t('InsightComparisonScreen.na') : formatPercent(pct)}
        />
      </dl>
      <p className="tm-prose tm-mono">{`${t('InsightComparisonScreen.computed')} ${formatMoment(comparison.computedAt)}.`}</p>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="tm-stat">
      <dt className="tm-field__hint">{label}</dt>
      <dd className="tm-stat__value tm-mono">{value}</dd>
    </div>
  );
}

/** A signed integer — `+2`, `0`, `-3` — so the direction reads at a glance. */
function formatDelta(delta: number): string {
  return delta > 0 ? `+${delta}` : String(delta);
}

/** A signed percentage from a fractional change (`0.5` → `+50%`). */
function formatPercent(fraction: number): string {
  const percent = Math.round(fraction * 1000) / 10;
  return percent > 0 ? `+${percent}%` : `${percent}%`;
}

/** A short label for a window, from two ISO instants. */
function windowCaption(startIso: string, endIso: string, t: Translate): string {
  return `${startIso.slice(0, 10)} ${t('InsightComparisonScreen.to')} ${endIso.slice(0, 10)}`;
}

/**
 * Format an ISO timestamp for display, following the browser's locale. An unparseable value is shown
 * verbatim rather than as `Invalid Date`.
 */
function formatMoment(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return new Intl.DateTimeFormat(appIntlLocale(), {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(at);
}

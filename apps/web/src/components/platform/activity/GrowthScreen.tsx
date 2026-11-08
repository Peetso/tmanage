'use client';

import { useCallback, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiBaseUrl, browserApiClient } from '../../../lib/api/browser-client';
import type { ApiClient } from '../../../lib/api/client';
import {
  barHeights,
  fetchGrowth,
  funnelPercents,
  growthCsvPath,
  percent,
} from '../../../lib/api/platform-growth';
import type { GrowthPeriod, GrowthView } from '../../../lib/api/platform-growth';
import { useDisplayFormatters } from '../../../lib/i18n/use-formatters';
import { useT } from '../../../lib/i18n/use-t';
import { useTOr } from '../../../lib/i18n/use-t-or';
import type { ScreenProps } from '../shared/platform-kit';
import { PlatformGate } from '../shared/platform-kit';
import { PlatformPageState } from '../shared/PlatformPageState';
import { ACTIVITY_KEY } from './ActivityFrame';
import { GROWTH_COPY } from './growth-copy';
import type { GrowthCopyKey } from './growth-copy';
import '../../../styles/screens/r44-security-growth.css';

type Copy = (key: GrowthCopyKey) => string;

function useCopy(): Copy {
  const tOr = useTOr();
  return useCallback((key: GrowthCopyKey) => tOr(`PlatformGrowth.${key}`, GROWTH_COPY[key]), [tOr]);
}

/**
 * 57-09 · Platform admin "Growth" (Figma 578:32859 "Growth · platform · EN/AR"): sign-ups,
 * activation, client activation and time to first project, a sign-ups bar chart, the activation
 * steps and the weekly retention cohorts — all from `GET /v1/platform/activity/growth`
 * (`platform.activity.view`), platform-wide aggregates only.
 */
export function GrowthScreen({ client }: ScreenProps) {
  const api = client ?? browserApiClient();
  const t = useT();
  const copy = useCopy();
  const [period, setPeriod] = useState<GrowthPeriod>('month');
  return (
    <PlatformGate
      api={api}
      section="activity"
      crumbs={[t('PlatformActivity.crumb'), copy('title')]}
      title={copy('title')}
      description={copy('description')}
      actions={() => (
        <>
          <div className="tm-r44-chips" role="group" aria-label={copy('periodLabel')}>
            {(['month', 'week'] as const).map((id) => (
              <button
                key={id}
                type="button"
                className={period === id ? 'tm-chip tm-chip--active' : 'tm-chip'}
                aria-pressed={period === id}
                onClick={() => setPeriod(id)}
              >
                {copy(id)}
              </button>
            ))}
          </div>
          <a
            className="tm-button tm-button--ink tm-button--default"
            href={`${apiBaseUrl()}${growthCsvPath(period)}`}
            download
          >
            {copy('downloadCsv')}
          </a>
        </>
      )}
    >
      {() => <GrowthBody api={api} period={period} />}
    </PlatformGate>
  );
}

function GrowthBody({ api, period }: { api: ApiClient; period: GrowthPeriod }) {
  const copy = useCopy();
  const growth = useQuery({
    queryKey: [...ACTIVITY_KEY, 'growth', period],
    queryFn: () => fetchGrowth(api, period),
  });
  if (growth.isPending) return <PlatformPageState state="loading" />;
  if (growth.isError) {
    return (
      <PlatformPageState state="error" error={growth.error} onRetry={() => void growth.refetch()} />
    );
  }
  if (growth.data.computedAt === null) {
    return <PlatformPageState state="empty" title={copy('emptyTitle')} body={copy('emptyBody')} />;
  }
  return <Growth view={growth.data} />;
}

function Growth({ view }: { view: GrowthView }) {
  const copy = useCopy();
  const format = useDisplayFormatters();
  const pct = (rate: number | null) => {
    const value = percent(rate);
    return value === null ? copy('noData') : `${format.number(value)} %`;
  };
  const hours = (value: number | null) =>
    value === null
      ? copy('noData')
      : `${format.number(value, { maximumFractionDigits: 1 })} ${copy('hours')}`;
  const tiles = [
    {
      id: 'signups',
      label: copy('signups'),
      value: format.number(view.tiles.signups),
      note: copy('inRange'),
    },
    {
      id: 'activation',
      label: copy('activation'),
      value: pct(view.tiles.activationRate7d),
      note: copy('within7'),
    },
    {
      id: 'client',
      label: copy('clientActivation'),
      value: pct(view.tiles.serviceActivationRate14d),
      note: copy('within14'),
    },
    {
      id: 'first-project',
      label: copy('firstProject'),
      value: hours(view.tiles.timeToFirstProjectP50Hours),
      note: copy('median'),
    },
  ];
  const series = view.tables.series;
  const heights = barHeights(series);
  const steps = funnelPercents(view.tables.activationFunnel);
  const label = (start: string) =>
    view.period === 'month'
      ? format.day(`${start}T00:00:00Z`, { month: 'short' })
      : format.day(`${start}T00:00:00Z`, { day: 'numeric', month: 'short' });
  return (
    <div className="tm-stack">
      <ul className="tm-cc-metrics tm-r44-kpis" aria-label={copy('kpiLabel')}>
        {tiles.map((tile) => (
          <li key={tile.id} className="tm-cc-metric">
            <p className="tm-cc-metric__source">{tile.label}</p>
            <p className="tm-cc-metric__value">{tile.value}</p>
            <p className="tm-r44-sub">{tile.note}</p>
          </li>
        ))}
      </ul>
      <div className="tm-cc-split tm-cc-split--even tm-cc-split--stretch">
        <section className="tm-cc-card" aria-labelledby="tm-growth-chart-title">
          <h2 id="tm-growth-chart-title" className="tm-cc-card__title">
            {view.period === 'month' ? copy('signupsByMonth') : copy('signupsByWeek')}
          </h2>
          <ol className="tm-r44-bars">
            {series.map((row, index) => (
              <li
                key={row.periodStart}
                className="tm-r44-bars__col"
                aria-label={`${label(row.periodStart)}: ${format.number(row.signups)}`}
              >
                <span
                  className={
                    index === series.length - 1
                      ? 'tm-r44-bars__bar tm-r44-bars__bar--now'
                      : 'tm-r44-bars__bar'
                  }
                  style={{ blockSize: `${String(heights[index] ?? 0)}%` }}
                  aria-hidden="true"
                />
                <span className="tm-r44-bars__label" aria-hidden="true">
                  {label(row.periodStart)}
                </span>
              </li>
            ))}
          </ol>
        </section>
        <section className="tm-cc-card" aria-labelledby="tm-growth-funnel-title">
          <h2 id="tm-growth-funnel-title" className="tm-cc-card__title">
            {copy('activationSteps')}
          </h2>
          <ol className="tm-r44-funnel">
            {steps.map((step) => (
              <li key={step.step} className="tm-r44-funnel__step">
                <span>{copy(`step_${step.step}` as GrowthCopyKey)}</span>
                <span className="tm-cc-bar" aria-hidden="true">
                  <span
                    className="tm-cc-bar__fill"
                    style={{ inlineSize: `${String(step.percent)}%` }}
                  />
                </span>
                <span className="tm-cc-cell-mono">{format.number(step.percent)} %</span>
              </li>
            ))}
          </ol>
        </section>
      </div>
      <section className="tm-cc-card" aria-labelledby="tm-growth-retention-title">
        <h2 id="tm-growth-retention-title" className="tm-cc-card__title">
          {copy('retentionTitle')}
        </h2>
        <table className="tm-table tm-cc-table tm-r44-retention">
          <thead>
            <tr>
              <th scope="col">{copy('colWeek')}</th>
              <th scope="col">{copy('colPeople')}</th>
              {(view.tables.retention[0]?.weeks ?? []).map((_, index) => (
                <th key={index} scope="col">
                  {copy('weekShort')}
                  {format.number(index + 1)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {view.tables.retention.map((cohort) => (
              <tr key={cohort.cohortWeek}>
                <th scope="row" className="tm-cc-cell-mono">
                  <bdi dir="ltr">{cohort.cohortWeek}</bdi>
                </th>
                <td className="tm-cc-cell-mono">{format.number(cohort.size)}</td>
                {cohort.weeks.map((rate, index) => {
                  const value = percent(rate);
                  return (
                    <td key={index} className="tm-cc-cell-mono">
                      {value === null ? (
                        '—'
                      ) : (
                        <span className="tm-r44-heat" data-level={String(Math.ceil(value / 25))}>
                          {format.number(value)} %
                        </span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

'use client';

import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import type { ApiClient } from '../../lib/api/client';
import { ApiRequestError } from '../../lib/api/errors';
import { getBudgetBurn } from '../../lib/api/project-budget-burn';
import { getProjectBudget } from '../../lib/api/project-budget';
import {
  burnLine,
  forecastBurn,
  hoursValue,
  weeklyPace,
  type BurnPoint,
  type BurnState,
} from '../../lib/budget-burn-forecast';
import { useDisplayFormatters } from '../../lib/i18n/use-formatters';
import { useTOr } from '../../lib/i18n/use-t-or';
import './budget-burn-panel.css';

/**
 * 52-05 — the budget burn panel on the project overview (Figma `574:32611`, "R43 L2"): hours (and,
 * with `finance.view`, money) used against the budget, the cumulative burn line over the last
 * twelve weeks, the forecast finish at the current pace and an over-budget warning.
 *
 * The burn report is `work.read`; the budget figures are `project.manage`. A member without the
 * latter still sees the line and the hours burned, without the budget it is measured against.
 */

const CHART_W = 420;
const CHART_H = 140;
const PAD = 12;

const STATUS_CLASS: Record<Exclude<BurnState, 'no_budget'>, string> = {
  on_track: 'tm-burn__status--ok',
  at_risk: 'tm-burn__status--risk',
  over: 'tm-burn__status--over',
};

function BurnChart({
  points,
  budgetMinutes,
  label,
}: {
  points: readonly BurnPoint[];
  budgetMinutes: number | null;
  label: string;
}) {
  const top = Math.max(budgetMinutes ?? 0, ...points.map((point) => point.cumulativeMinutes), 1);
  const y = (minutes: number) => CHART_H - PAD - (minutes / (top * 1.05)) * (CHART_H - 2 * PAD);
  const span = Math.max(points.length - 1, 1);
  // The line takes three quarters of the width; the rest is room for the dashed forecast.
  const x = (index: number) => PAD + (index / span) * (CHART_W * 0.72);
  const line = points.map((point, index) => `${x(index)},${y(point.cumulativeMinutes)}`).join(' ');
  const last = points[points.length - 1];
  return (
    <svg
      className="tm-burn__chart"
      viewBox={`0 0 ${CHART_W} ${CHART_H}`}
      role="img"
      aria-label={label}
      preserveAspectRatio="none"
    >
      {budgetMinutes !== null ? (
        <line
          className="tm-burn__budget-line"
          x1={PAD}
          x2={CHART_W - PAD}
          y1={y(budgetMinutes)}
          y2={y(budgetMinutes)}
        />
      ) : null}
      {points.length > 0 ? <polyline className="tm-burn__line" points={line} /> : null}
      {last && budgetMinutes !== null && last.cumulativeMinutes < budgetMinutes ? (
        <line
          className="tm-burn__forecast-line"
          x1={x(points.length - 1)}
          y1={y(last.cumulativeMinutes)}
          x2={CHART_W - PAD}
          y2={y(budgetMinutes)}
        />
      ) : null}
    </svg>
  );
}

export interface BudgetBurnPanelProps {
  api: ApiClient;
  organizationSlug: string;
  projectId: string;
  /** Injectable for tests; the panel's "today" for the forecast. */
  today?: string;
}

export function BudgetBurnPanel({ api, organizationSlug, projectId, today }: BudgetBurnPanelProps) {
  const tr = useTOr();
  const format = useDisplayFormatters();
  const burn = useQuery({
    queryKey: ['project-budget-burn', organizationSlug, projectId],
    queryFn: () => getBudgetBurn(api, organizationSlug, projectId),
    retry: false,
  });
  const budget = useQuery({
    queryKey: ['project-budget', organizationSlug, projectId],
    queryFn: () => getProjectBudget(api, organizationSlug, projectId),
    retry: false,
  });

  const title = tr('BudgetBurn.title', 'Budget burn');
  const hours = (minutes: number) =>
    tr('BudgetBurn.hours', '{hours} h').replace('{hours}', format.number(hoursValue(minutes)));

  // A member without the budget capability, or a project without burn access, sees no panel.
  if (burn.isError && burn.error instanceof ApiRequestError && burn.error.status === 404) {
    return null;
  }
  // An answer without buckets (an older API) has nothing to draw.
  if (burn.data && !Array.isArray(burn.data.buckets)) return null;

  let body: ReactNode;
  let status: ReactNode = null;
  if (burn.isPending || budget.isPending) {
    body = (
      <LoadingRegion label={tr('BudgetBurn.loading', 'Loading the budget burn')}>
        <Skeleton height="var(--row)" />
      </LoadingRegion>
    );
  } else if (burn.isError) {
    body = (
      <InlineAlert tone="danger" title={tr('BudgetBurn.loadFailed', 'The burn did not load')}>
        {tr('BudgetBurn.loadFailedBody', 'Try again in a moment.')}
      </InlineAlert>
    );
  } else {
    const summary = budget.data ?? null;
    const budgetMinutes =
      summary?.budgetHours === null || summary?.budgetHours === undefined
        ? null
        : Math.round(summary.budgetHours * 60);
    const rangeMinutes = burn.data.buckets.reduce((sum, bucket) => sum + bucket.minutes, 0);
    // Live P1 (deploy 38bab83c): the live total of logged time, never the swept cache — the cache
    // stays 0 on a project with no budget row and lags a fresh entry by up to a sweep.
    const usedMinutes = summary ? Math.round(summary.trackedHours * 60) : rangeMinutes;
    const points = burnLine(burn.data.buckets, usedMinutes);
    const forecast = forecastBurn({
      budgetMinutes,
      usedMinutes,
      weeklyMinutes: weeklyPace(burn.data.buckets, burn.data.from, burn.data.to),
      today: today ?? new Date().toISOString().slice(0, 10),
      serverForecast: burn.data.forecastExhaustedOn,
    });
    const money =
      summary?.budgetAmountMinor != null &&
      summary.usedAmountCacheMinor !== undefined &&
      summary.currency
        ? tr('BudgetBurn.moneyUsed', '{used} of {budget}')
            .replace('{used}', format.money(summary.usedAmountCacheMinor, summary.currency))
            .replace('{budget}', format.money(summary.budgetAmountMinor, summary.currency))
        : null;
    const statusLabel: Record<Exclude<BurnState, 'no_budget'>, string> = {
      on_track: tr('BudgetBurn.onTrack', 'On track'),
      at_risk: tr('BudgetBurn.atRisk', 'At risk'),
      over: tr('BudgetBurn.over', 'Over budget'),
    };
    const percent = forecast.percent ?? 0;
    if (forecast.state !== 'no_budget') {
      status = (
        <span className={`tm-burn__status ${STATUS_CLASS[forecast.state]}`}>
          {statusLabel[forecast.state]}
        </span>
      );
    }
    body = (
      <>
        <div className="tm-burn__figures">
          {forecast.percent !== null ? (
            <span className="tm-burn__percent">
              {format.number(percent / 100, { style: 'percent' })}
            </span>
          ) : null}
          <span className="tm-burn__used">
            <span>
              {budgetMinutes !== null
                ? tr('BudgetBurn.hoursUsed', '{used} of {budget} used')
                    .replace('{used}', hours(usedMinutes))
                    .replace('{budget}', hours(budgetMinutes))
                : tr('BudgetBurn.hoursBurned', '{used} logged').replace(
                    '{used}',
                    hours(usedMinutes),
                  )}
            </span>
            {money ? <span className="tm-burn__money">{money}</span> : null}
          </span>
        </div>
        {forecast.percent !== null ? (
          <div
            className={`tm-burn__bar tm-burn__bar--${forecast.state}`}
            role="progressbar"
            aria-label={title}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.min(percent, 100)}
          >
            <span style={{ inlineSize: `${Math.min(percent, 100)}%` }} />
          </div>
        ) : null}
        <BurnChart
          points={points}
          budgetMinutes={budgetMinutes}
          label={tr('BudgetBurn.chartLabel', 'Hours used, week by week, over the last 12 weeks')}
        />
        <p className="tm-burn__axis">{tr('BudgetBurn.axis', 'Last 12 weeks')}</p>
        {forecast.state === 'over' ? (
          <InlineAlert tone="danger" title={tr('BudgetBurn.over', 'Over budget')} live>
            {tr(
              'BudgetBurn.overBody',
              '{over} more than the {budget} budget. Talk to the project owner before logging more.',
            )
              .replace('{over}', hours(forecast.overMinutes))
              .replace('{budget}', hours(budgetMinutes ?? 0))}
          </InlineAlert>
        ) : forecast.state === 'no_budget' ? (
          <p className="tm-burn__forecast">
            {tr('BudgetBurn.noBudget', 'No hours budget is set for this project.')}
          </p>
        ) : forecast.finishOn ? (
          <p className="tm-burn__forecast">
            {tr('BudgetBurn.forecast', 'At this pace the budget runs out on {day}.').replace(
              '{day}',
              format.day(forecast.finishOn),
            )}
          </p>
        ) : (
          <p className="tm-burn__forecast">
            {tr('BudgetBurn.noPace', 'No time logged in the last 12 weeks, so no forecast yet.')}
          </p>
        )}
      </>
    );
  }

  return (
    <section className="tm-card tm-prj-card tm-burn" aria-labelledby="tm-project-burn">
      <div className="tm-burn__head">
        <h2 id="tm-project-burn" className="tm-section-head__title">
          {title}
        </h2>
        {status}
      </div>
      {body}
    </section>
  );
}

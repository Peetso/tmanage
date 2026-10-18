'use client';

import { useQuery } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import {
  InsightsCard,
  InsightsCardHead,
  InsightsNote,
  InsightsSplit,
  InsightsTabs,
} from './InsightsKit';
import { browserApiClient } from '../../lib/api/browser-client';
import { fetchWorkloadForecast } from '../../lib/api/workload-forecast';
import type { WorkloadForecastView, WorkloadForecastWeek } from '../../lib/api/workload-forecast';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface InsightsForecastScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** Injected in tests. Defaults to the browser client. */
  client?: ApiClient;
}

/**
 * **Workload forecast** — x134's insights read, the forward-looking counterpart to INS-05's current
 * workload roll-up. It reads `GET /v1/organizations/:orgSlug/insights/workload-forecast`, gated on
 * the server by `work.read`, and shows committed open work projected into the upcoming weeks against
 * a constant per-member capacity, flagging the weeks that exceed it.
 *
 * Two decisions, both from the sibling insights screens:
 *
 * 1. **Authorization is the API's.** A caller without `work.read` gets the ordinary 403, which
 *    `describe()` turns into a sentence; the screen never guesses a capability of its own.
 * 2. **No invented numbers.** An empty portfolio shows every week at zero, plainly labelled — and
 *    the capacity model is stated as constant-per-member so no reader mistakes it for a real one.
 */
export function InsightsForecastScreen({
  organizationSlug,
  organizationName,
  client,
}: InsightsForecastScreenProps) {
  const api = client ?? browserApiClient();

  const forecast = useQuery({
    queryKey: ['insights-workload-forecast', organizationSlug],
    queryFn: () => fetchWorkloadForecast(api, organizationSlug),
  });

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="insights"
      eyebrow={
        forecast.data
          ? `Insights · Workload · ${forecast.data.totals.weeks} weeks · ${forecast.data.totals.memberCount} ${forecast.data.totals.memberCount === 1 ? 'member' : 'members'}`
          : 'Insights · Workload'
      }
      title="What we have promised for the coming weeks"
    >
      <div className="tm-ins">
        <InsightsTabs organizationSlug={organizationSlug} current="workload" />

        {forecast.isPending ? (
          <LoadingRegion label="Loading workload forecast." className="tm-stack tm-stack--tight">
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {forecast.isError ? (
          <InlineAlert tone="danger" title="Could not load the workload forecast" live>
            {describe(forecast.error)}
          </InlineAlert>
        ) : null}

        {forecast.isSuccess ? <ForecastPanel forecast={forecast.data} /> : null}
      </div>
    </AppShell>
  );
}

function ForecastPanel({ forecast }: { forecast: WorkloadForecastView }) {
  const { totals } = forecast;
  const firstOver = forecast.weeks.find((week) => week.overCapacity);

  return (
    <>
      <InsightsCard labelledBy="tm-forecast-capacity-heading">
        <InsightsCardHead
          id="tm-forecast-capacity-heading"
          title="Committed work against capacity"
          units="Team level · committed items, not hours logged"
        />
        <ul className="tm-ins-capacity" aria-hidden="true">
          {forecast.weeks.map((week) => (
            <CapacityRow key={week.weekIndex} week={week} />
          ))}
        </ul>
        <p className="tm-ins-card__body">
          A slot is one committed work item with a date. Capacity is a constant{' '}
          {perMemberCapacity(totals)} items per member per week across {totals.memberCount}{' '}
          {totals.memberCount === 1 ? 'member' : 'members'} carrying open work.
        </p>
      </InsightsCard>

      <InsightsSplit
        main={
          <InsightsCard variant="table" labelledBy="tm-forecast-heading">
            <div className="tm-ins-card__lead">
              <InsightsCardHead
                id="tm-forecast-heading"
                title="Across projects"
                units="Week · committed · capacity"
              />
            </div>
            {totals.committedItemCount === 0 ? (
              <p className="tm-ins-card__body tm-ins-card__lead">
                No committed, dated work in the forecast window yet.
              </p>
            ) : null}
            <table
              className="tm-ins-table tm-ins-table--dense"
              aria-labelledby="tm-forecast-heading"
            >
              <caption className="tm-visually-hidden">
                Committed work by upcoming week against capacity
              </caption>
              <thead>
                <tr>
                  <th scope="col">Week</th>
                  <th scope="col">Starting</th>
                  <th scope="col" className="tm-ins-table__num">
                    Committed
                  </th>
                  <th scope="col" className="tm-ins-table__num">
                    Capacity
                  </th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {forecast.weeks.map((week) => (
                  <WeekRow key={week.weekIndex} week={week} />
                ))}
              </tbody>
            </table>
            <p className="tm-ins-card__foot">Computed {formatMoment(forecast.computedAt)}.</p>
          </InsightsCard>
        }
        side={
          <>
            <InsightsCard variant="callout">
              <p className="tm-ins-eyebrow">The one thing to fix first</p>
              <p className="tm-ins-callout__title">
                {firstOver
                  ? `Week ${firstOver.weekIndex} carries ${firstOver.committedItemCount} committed items against ~${firstOver.capacity} slots.`
                  : 'Every week in the window is within capacity.'}
              </p>
              <p className="tm-ins-card__body">
                {totals.overCapacityWeekCount > 0
                  ? `${totals.overCapacityWeekCount} of ${totals.weeks} weeks are over. Moving one date now is a conversation; moving it on the day is a missed commitment.`
                  : `${totals.committedItemCount} committed items across ${totals.weeks} weeks, against ${totals.capacity} slots.`}
              </p>
            </InsightsCard>
            <InsightsNote eyebrow="Not a productivity view">
              No hours tracked, no output counted, no person ranked. Capacity is what the team
              promised against what it declared it could take.
            </InsightsNote>
          </>
        }
      />
    </>
  );
}

/** INS-05's capacity row: the week, its committed share of the slots, and the "over" flag. */
function CapacityRow({ week }: { week: WorkloadForecastWeek }) {
  const width =
    week.capacity === 0
      ? week.committedItemCount > 0
        ? 100
        : 0
      : Math.min(100, Math.round((week.committedItemCount / week.capacity) * 100));
  return (
    <li className="tm-ins-capacity__row" data-over={week.overCapacity || undefined}>
      <span className="tm-ins-capacity__name">
        Week {week.weekIndex}
        <span className="tm-ins-capacity__sub">starting {formatDay(week.startsAt)}</span>
      </span>
      <span className="tm-ins-capacity__track">
        <span className="tm-ins-capacity__fill" style={{ inlineSize: `${width}%` }} />
      </span>
      <span className="tm-ins-capacity__value">
        {week.committedItemCount} of ~{week.capacity} slots{week.overCapacity ? ' · over' : ''}
      </span>
    </li>
  );
}

function WeekRow({ week }: { week: WorkloadForecastWeek }) {
  return (
    <tr data-tone={week.overCapacity ? 'danger' : 'quiet'}>
      <th scope="row">Week {week.weekIndex}</th>
      <td>{formatDay(week.startsAt)}</td>
      <td className="tm-ins-table__num" {...(week.overCapacity ? { 'data-tone': 'danger' } : {})}>
        {week.committedItemCount}
      </td>
      <td className="tm-ins-table__num">{week.capacity}</td>
      <td>
        <span className="tm-ins-badge" data-tone={week.overCapacity ? 'danger' : 'quiet'}>
          {week.overCapacity ? 'Over capacity' : 'Within capacity'}
        </span>
      </td>
    </tr>
  );
}

/** The per-member weekly capacity, recovered from the totals so the copy never hard-codes the constant. */
function perMemberCapacity(totals: WorkloadForecastView['totals']): number {
  if (totals.memberCount === 0 || totals.weeks === 0) return 0;
  return totals.capacity / totals.weeks / totals.memberCount;
}

/** Turn a thrown value into a sentence a person can act on. Never leaks a stack or a cause. */
function describe(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Check that it is running.';
  return 'Something went wrong. Try again.';
}

/** Format an ISO week-start for display, date only. An unparseable value is shown verbatim. */
function formatDay(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(at);
}

/** Format an ISO timestamp for display, following the browser's locale. Unparseable is verbatim. */
function formatMoment(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(at);
}

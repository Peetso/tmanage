'use client';

import { useQuery } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
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
      title="Workload forecast"
      description="Committed work projected into the upcoming weeks, against a constant per-member capacity."
    >
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
    </AppShell>
  );
}

function ForecastPanel({ forecast }: { forecast: WorkloadForecastView }) {
  const { totals } = forecast;
  const scale = Math.max(
    totals.capacity === 0 ? 0 : Math.max(...forecast.weeks.map((w) => w.capacity)),
    ...forecast.weeks.map((w) => w.committedItemCount),
    1,
  );

  return (
    <section className="tm-panel tm-stack" aria-labelledby="tm-forecast-heading">
      <h2 id="tm-forecast-heading" className="tm-eyebrow">
        Across projects
      </h2>

      <p className="tm-prose">
        Capacity is a constant {perMemberCapacity(totals)} items per member per week across{' '}
        {totals.memberCount} {totals.memberCount === 1 ? 'member' : 'members'} carrying open work —
        a placeholder until per-person assignment lands.
      </p>

      {totals.committedItemCount === 0 ? (
        <p className="tm-prose">No committed, dated work in the forecast window yet.</p>
      ) : null}

      <table className="tm-table" aria-labelledby="tm-forecast-heading">
        <caption className="tm-visually-hidden">
          Committed work by upcoming week against capacity
        </caption>
        <thead>
          <tr>
            <th scope="col">Week</th>
            <th scope="col">Starting</th>
            <th scope="col" className="tm-table__number">
              Committed
            </th>
            <th scope="col" className="tm-table__number">
              Capacity
            </th>
            <th scope="col">Status</th>
          </tr>
        </thead>
        <tbody>
          {forecast.weeks.map((week) => (
            <WeekRow key={week.weekIndex} week={week} scale={scale} />
          ))}
        </tbody>
      </table>

      <p className="tm-prose tm-mono">Computed {formatMoment(forecast.computedAt)}.</p>
    </section>
  );
}

function WeekRow({ week, scale }: { week: WorkloadForecastWeek; scale: number }) {
  const width = scale === 0 ? 0 : Math.round((week.committedItemCount / scale) * 100);
  return (
    <tr>
      <th scope="row">Week {week.weekIndex}</th>
      <td className="tm-mono">{formatDay(week.startsAt)}</td>
      <td className="tm-mono tm-table__number">
        {week.committedItemCount}
        <span
          className="tm-bar"
          aria-hidden="true"
          style={{
            display: 'block',
            height: '0.4rem',
            marginTop: '0.25rem',
            width: `${width}%`,
            minWidth: week.committedItemCount > 0 ? '2px' : 0,
            background: week.overCapacity ? 'var(--danger-600)' : 'var(--lime-600)',
            borderRadius: '9999px',
          }}
        />
      </td>
      <td className="tm-mono tm-table__number">{week.capacity}</td>
      <td>{week.overCapacity ? 'Over capacity' : 'Within capacity'}</td>
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

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
import { useDescribeApiError } from '../../lib/api/describe-error';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';
import type { MessageKey } from '../../lib/i18n/t';

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
  const describe = useDescribeApiError();
  const api = client ?? browserApiClient();
  const t = useT();

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
          ? `${t('InsightsForecastScreen.eyebrow')} · ${forecast.data.totals.weeks} ${t('InsightsForecastScreen.nounWeeks')} · ${forecast.data.totals.memberCount} ${
              forecast.data.totals.memberCount === 1
                ? t('InsightsForecastScreen.nounMember')
                : t('InsightsForecastScreen.nounMembers')
            }`
          : t('InsightsForecastScreen.eyebrow')
      }
      title={t('InsightsForecastScreen.title')}
    >
      <div className="tm-ins">
        <InsightsTabs organizationSlug={organizationSlug} current="workload" />

        {forecast.isPending ? (
          <LoadingRegion
            label={t('InsightsForecastScreen.loading')}
            className="tm-stack tm-stack--tight"
          >
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {forecast.isError ? (
          <InlineAlert tone="danger" title={t('InsightsForecastScreen.loadErrorTitle')} live>
            {describe(forecast.error)}
          </InlineAlert>
        ) : null}

        {forecast.isSuccess ? <ForecastPanel forecast={forecast.data} /> : null}
      </div>
    </AppShell>
  );
}

function ForecastPanel({ forecast }: { forecast: WorkloadForecastView }) {
  const t = useT();
  const { totals } = forecast;
  // With no one carrying open work the capacity basis is zero, which would otherwise flag every week
  // as "over" and alarm the reader for no reason (BIL-05). When that is the case we stop drawing the
  // over-capacity verdict and show a plain setup prompt instead of a false alarm.
  const capacityKnown = totals.capacity > 0;
  const firstOver = capacityKnown ? forecast.weeks.find((week) => week.overCapacity) : undefined;

  return (
    <>
      <InsightsCard labelledBy="tm-forecast-capacity-heading">
        <InsightsCardHead
          id="tm-forecast-capacity-heading"
          title={t('InsightsForecastScreen.capacityHeadTitle')}
          units={t('InsightsForecastScreen.capacityHeadUnits')}
        />
        <ul className="tm-ins-capacity" aria-hidden="true">
          {forecast.weeks.map((week) => (
            <CapacityRow key={week.weekIndex} week={week} capacityKnown={capacityKnown} />
          ))}
        </ul>
        <p className="tm-ins-card__body">
          {capacityKnown ? (
            <>
              {t('InsightsForecastScreen.slotIntro')} {perMemberCapacity(totals)}{' '}
              {perMemberCapacity(totals) === 1
                ? t('InsightsForecastScreen.nounItem')
                : t('InsightsForecastScreen.nounItems')}{' '}
              {t('InsightsForecastScreen.perMemberPerWeekAcross')}{' '}
              {count(
                totals.memberCount,
                t,
                'InsightsForecastScreen.nounMember',
                'InsightsForecastScreen.nounMembers',
              )}{' '}
              {t('InsightsForecastScreen.carryingOpenWork')}
            </>
          ) : (
            <>{t('InsightsForecastScreen.noCapacityBody')}</>
          )}
        </p>
      </InsightsCard>

      <InsightsSplit
        main={
          <InsightsCard variant="table" labelledBy="tm-forecast-heading">
            <div className="tm-ins-card__lead">
              <InsightsCardHead
                id="tm-forecast-heading"
                title={t('InsightsForecastScreen.acrossProjects')}
                units={t('InsightsForecastScreen.acrossProjectsUnits')}
              />
            </div>
            {totals.committedItemCount === 0 ? (
              <p className="tm-ins-card__body tm-ins-card__lead">
                {t('InsightsForecastScreen.noCommittedWork')}
              </p>
            ) : null}
            <table
              className="tm-ins-table tm-ins-table--dense"
              aria-labelledby="tm-forecast-heading"
            >
              <caption className="tm-visually-hidden">
                {t('InsightsForecastScreen.tableCaption')}
              </caption>
              <thead>
                <tr>
                  <th scope="col">{t('InsightsForecastScreen.colWeek')}</th>
                  <th scope="col">{t('InsightsForecastScreen.colStarting')}</th>
                  <th scope="col" className="tm-ins-table__num">
                    {t('InsightsForecastScreen.colCommitted')}
                  </th>
                  <th scope="col" className="tm-ins-table__num">
                    {t('InsightsForecastScreen.colCapacity')}
                  </th>
                  <th scope="col">{t('InsightsForecastScreen.colStatus')}</th>
                </tr>
              </thead>
              <tbody>
                {forecast.weeks.map((week) => (
                  <WeekRow key={week.weekIndex} week={week} capacityKnown={capacityKnown} />
                ))}
              </tbody>
            </table>
            <p className="tm-ins-card__foot">
              {t('InsightsForecastScreen.computed')} {formatMoment(forecast.computedAt)}.
            </p>
          </InsightsCard>
        }
        side={
          <>
            <InsightsCard variant="callout">
              {capacityKnown ? (
                <>
                  <p className="tm-ins-eyebrow">{t('InsightsForecastScreen.fixFirstEyebrow')}</p>
                  <p className="tm-ins-callout__title">
                    {firstOver
                      ? `${t('InsightsForecastScreen.weekWord')} ${firstOver.weekIndex} ${t('InsightsForecastScreen.carries')} ${count(
                          firstOver.committedItemCount,
                          t,
                          'InsightsForecastScreen.nounCommittedItem',
                          'InsightsForecastScreen.nounCommittedItems',
                        )} ${t('InsightsForecastScreen.against')} ~${count(
                          firstOver.capacity,
                          t,
                          'InsightsForecastScreen.nounSlot',
                          'InsightsForecastScreen.nounSlots',
                        )}.`
                      : t('InsightsForecastScreen.everyWeekWithin')}
                  </p>
                  <p className="tm-ins-card__body">
                    {totals.overCapacityWeekCount > 0
                      ? `${totals.overCapacityWeekCount} ${t('InsightsForecastScreen.ofWord')} ${count(
                          totals.weeks,
                          t,
                          'InsightsForecastScreen.nounWeek',
                          'InsightsForecastScreen.nounWeeks',
                        )} ${t('InsightsForecastScreen.areOverRest')}`
                      : `${count(
                          totals.committedItemCount,
                          t,
                          'InsightsForecastScreen.nounCommittedItem',
                          'InsightsForecastScreen.nounCommittedItems',
                        )} ${t('InsightsForecastScreen.across')} ${count(
                          totals.weeks,
                          t,
                          'InsightsForecastScreen.nounWeek',
                          'InsightsForecastScreen.nounWeeks',
                        )}, ${t('InsightsForecastScreen.against')} ${count(
                          totals.capacity,
                          t,
                          'InsightsForecastScreen.nounSlot',
                          'InsightsForecastScreen.nounSlots',
                        )}.`}
                  </p>
                </>
              ) : (
                <>
                  <p className="tm-ins-eyebrow">{t('InsightsForecastScreen.setWeeklyCapacity')}</p>
                  <p className="tm-ins-callout__title">
                    {t('InsightsForecastScreen.cannotSayOverloaded')}
                  </p>
                  <p className="tm-ins-card__body">
                    {t('InsightsForecastScreen.forNowShows')}{' '}
                    {count(
                      totals.committedItemCount,
                      t,
                      'InsightsForecastScreen.nounCommittedItem',
                      'InsightsForecastScreen.nounCommittedItems',
                    )}{' '}
                    {t('InsightsForecastScreen.across')}{' '}
                    {count(
                      totals.weeks,
                      t,
                      'InsightsForecastScreen.nounWeek',
                      'InsightsForecastScreen.nounWeeks',
                    )}
                    , {t('InsightsForecastScreen.withNoWeekOver')}
                  </p>
                </>
              )}
            </InsightsCard>
            <InsightsNote eyebrow={t('InsightsForecastScreen.noteEyebrow')}>
              {t('InsightsForecastScreen.noteBody')}
            </InsightsNote>
          </>
        }
      />
    </>
  );
}

/**
 * INS-05's capacity row: the week, its committed share of the slots, and the "over" flag. With no
 * capacity set (BIL-05) the "over" verdict is withheld and the slot figure is dropped, because a
 * zero denominator makes every week look full.
 */
function CapacityRow({
  week,
  capacityKnown,
}: {
  week: WorkloadForecastWeek;
  capacityKnown: boolean;
}) {
  const t = useT();
  const over = capacityKnown && week.overCapacity;
  const width =
    week.capacity === 0
      ? 0
      : Math.min(100, Math.round((week.committedItemCount / week.capacity) * 100));
  return (
    <li className="tm-ins-capacity__row" data-over={over || undefined}>
      <span className="tm-ins-capacity__name">
        {t('InsightsForecastScreen.weekWord')} {week.weekIndex}
        <span className="tm-ins-capacity__sub">
          {t('InsightsForecastScreen.startingPrefix')} {formatDay(week.startsAt)}
        </span>
      </span>
      <span className="tm-ins-capacity__track">
        <span className="tm-ins-capacity__fill" style={{ inlineSize: `${width}%` }} />
      </span>
      <span className="tm-ins-capacity__value">
        {capacityKnown
          ? `${count(
              week.committedItemCount,
              t,
              'InsightsForecastScreen.nounItem',
              'InsightsForecastScreen.nounItems',
            )} ${t('InsightsForecastScreen.ofWord')} ~${count(
              week.capacity,
              t,
              'InsightsForecastScreen.nounSlot',
              'InsightsForecastScreen.nounSlots',
            )}${over ? ` · ${t('InsightsForecastScreen.over')}` : ''}`
          : count(
              week.committedItemCount,
              t,
              'InsightsForecastScreen.nounItem',
              'InsightsForecastScreen.nounItems',
            )}
      </span>
    </li>
  );
}

function WeekRow({ week, capacityKnown }: { week: WorkloadForecastWeek; capacityKnown: boolean }) {
  const t = useT();
  const over = capacityKnown && week.overCapacity;
  return (
    <tr data-tone={over ? 'danger' : 'quiet'}>
      <th scope="row">
        {t('InsightsForecastScreen.weekWord')} {week.weekIndex}
      </th>
      <td>{formatDay(week.startsAt)}</td>
      <td className="tm-ins-table__num" {...(over ? { 'data-tone': 'danger' } : {})}>
        {week.committedItemCount}
      </td>
      <td className="tm-ins-table__num">{capacityKnown ? week.capacity : '—'}</td>
      <td>
        <span className="tm-ins-badge" data-tone={over ? 'danger' : 'quiet'}>
          {!capacityKnown
            ? t('InsightsForecastScreen.noCapacitySet')
            : over
              ? t('InsightsForecastScreen.overCapacity')
              : t('InsightsForecastScreen.withinCapacity')}
        </span>
      </td>
    </tr>
  );
}

/** "1 item" / "2 items" — a count then its noun, from singular/plural message keys. */
function count(
  n: number,
  t: (key: MessageKey) => string,
  singularKey: MessageKey,
  pluralKey: MessageKey,
): string {
  return `${n} ${t(n === 1 ? singularKey : pluralKey)}`;
}

/** The per-member weekly capacity, recovered from the totals so the copy never hard-codes the constant. */
function perMemberCapacity(totals: WorkloadForecastView['totals']): number {
  if (totals.memberCount === 0 || totals.weeks === 0) return 0;
  return totals.capacity / totals.weeks / totals.memberCount;
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

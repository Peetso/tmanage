'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import {
  InsightsBars,
  InsightsCard,
  InsightsCardHead,
  InsightsMetric,
  InsightsMetrics,
  InsightsSplit,
  InsightsTabs,
} from './InsightsKit';
import { browserApiClient } from '../../lib/api/browser-client';
import { fetchOrgAdoption } from '../../lib/api/insights-adoption';
import type {
  AdoptionGapId,
  InsightsAdoptionGapView,
  InsightsAdoptionView,
} from '../../lib/api/insights-adoption';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';
import type { MessageKey } from '../../lib/i18n/t';

export interface InsightsAdoptionScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** Injected in tests. Defaults to the browser client. */
  client?: ApiClient;
}

/**
 * **Adoption** — INS-06, the org-wide adoption read turned into a proven screen. It reads
 * `GET /v1/organizations/:orgSlug/insights/adoption` (gated on the server by `work.read`) and
 * renders the INS-06 frame: three system-quality figures (committed dates, channels feeding no work,
 * deliverables sent without a tracked version), the data-gap table, and where decisions get
 * recorded.
 *
 * The decisions are the sibling insights screens':
 * 1. **Authorization is the API's.** A caller without `work.read` gets the ordinary 403, which
 *    `describe()` turns into a sentence in the panel's own alert; the screen never guesses a
 *    capability of its own and never renders blank on a refusal.
 * 2. **No invented numbers.** The counts are the API's; the window they were computed over is shown
 *    plainly rather than assumed.
 * 3. **No charts dependency.** A semantic table with a caption and row scope carries the gaps; a11y
 *    is checked against the mounted document, not asserted.
 */
export function InsightsAdoptionScreen({
  organizationSlug,
  organizationName,
  client,
}: InsightsAdoptionScreenProps) {
  const api = client ?? browserApiClient();
  const t = useT();

  const adoption = useQuery({
    queryKey: ['insights-adoption', organizationSlug],
    queryFn: () => fetchOrgAdoption(api, organizationSlug, { days: WINDOW_DAYS }),
  });

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="insights"
      eyebrow={
        adoption.data
          ? `${t('InsightsAdoptionScreen.eyebrow')} · ${windowLabel(
              adoption.data.computedAt,
              adoption.data.windowDays,
            )}`
          : t('InsightsAdoptionScreen.eyebrow')
      }
      title={t('InsightsAdoptionScreen.title')}
      actions={
        <>
          <Link className="tm-button tm-button--outline" href={`/${organizationSlug}/settings`}>
            {t('InsightsAdoptionScreen.workspace')}
          </Link>
          <a className="tm-button tm-button--ink" href="#tm-adoption-gaps">
            {t('InsightsAdoptionScreen.fixDataGaps')}
          </a>
        </>
      }
    >
      <div className="tm-ins">
        <InsightsTabs organizationSlug={organizationSlug} current="adoption" />

        {adoption.isPending ? (
          <LoadingRegion
            label={t('InsightsAdoptionScreen.loading')}
            className="tm-stack tm-stack--tight"
          >
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {adoption.isError ? (
          <InlineAlert tone="danger" title={t('InsightsAdoptionScreen.loadErrorTitle')} live>
            {describe(adoption.error)}
          </InlineAlert>
        ) : null}

        {adoption.isSuccess ? (
          <AdoptionReport adoption={adoption.data} organizationSlug={organizationSlug} />
        ) : null}
      </div>
    </AppShell>
  );
}

/** The window the screen asks for — the frame's "last 14 days". */
const WINDOW_DAYS = 14;

/** Each data gap's row copy keys: what is missing, and what it breaks. */
const GAP_COPY: Readonly<Record<AdoptionGapId, { titleKey: MessageKey; breaksKey: MessageKey }>> = {
  chat_work_untriaged: {
    titleKey: 'InsightsAdoptionScreen.gapChatWorkTitle',
    breaksKey: 'InsightsAdoptionScreen.gapChatWorkBreaks',
  },
  client_files_internal: {
    titleKey: 'InsightsAdoptionScreen.gapClientFilesTitle',
    breaksKey: 'InsightsAdoptionScreen.gapClientFilesBreaks',
  },
  requests_uncommitted: {
    titleKey: 'InsightsAdoptionScreen.gapRequestsTitle',
    breaksKey: 'InsightsAdoptionScreen.gapRequestsBreaks',
  },
};

function percent(part: number, whole: number): number | undefined {
  return whole === 0 ? undefined : Math.round((part / whole) * 100);
}

function where(gap: InsightsAdoptionGapView, t: (key: MessageKey) => string): string {
  if (gap.projectCount === 0) return '—';
  if (gap.projectCount === 1) return gap.projectName ?? t('InsightsAdoptionScreen.oneProject');
  return `${gap.projectCount} ${t('InsightsAdoptionScreen.projectsSuffix')}`;
}

function AdoptionReport({
  adoption,
  organizationSlug,
}: {
  adoption: InsightsAdoptionView;
  organizationSlug: string;
}) {
  const t = useT();
  const { committedDate, channels, unhashedDeliverables, decisionsRecorded } = adoption;
  const dated = percent(committedDate.dated, committedDate.total);
  const datedBefore = percent(committedDate.previousDated, committedDate.previousTotal);
  const hashDelta = unhashedDeliverables.previous - unhashedDeliverables.current;
  const totalGaps = adoption.gaps.reduce((sum, gap) => sum + gap.count, 0);

  return (
    <>
      <InsightsMetrics label={t('InsightsAdoptionScreen.metricsLabel')}>
        <InsightsMetric
          value={dated === undefined ? '—' : `${dated}%`}
          {...(datedBefore === undefined
            ? {}
            : { badge: `${t('InsightsAdoptionScreen.was')} ${datedBefore}%` })}
          badgeTone={
            dated !== undefined && datedBefore !== undefined && dated < datedBefore
              ? 'warning'
              : 'quiet'
          }
          label={t('InsightsAdoptionScreen.metricDatedLabel')}
          note={t('InsightsAdoptionScreen.metricDatedNote')}
        />
        <InsightsMetric
          value={channels.withoutWork}
          badge={`${t('InsightsAdoptionScreen.ofCount')} ${channels.total}`}
          label={t('InsightsAdoptionScreen.metricChannelsLabel')}
          note={t('InsightsAdoptionScreen.metricChannelsNote')}
        />
        <InsightsMetric
          value={unhashedDeliverables.current}
          {...(hashDelta === 0
            ? {}
            : {
                badge:
                  hashDelta > 0
                    ? `${t('InsightsAdoptionScreen.down')} ${hashDelta}`
                    : `${t('InsightsAdoptionScreen.up')} ${-hashDelta}`,
              })}
          badgeTone={hashDelta > 0 ? 'lime' : 'warning'}
          label={t('InsightsAdoptionScreen.metricDeliverablesLabel')}
          note={t('InsightsAdoptionScreen.metricDeliverablesNote')}
        />
      </InsightsMetrics>

      <InsightsSplit
        main={
          <InsightsCard
            variant="table"
            id="tm-adoption-gaps"
            label={t('InsightsAdoptionScreen.dataGaps')}
          >
            <table className="tm-ins-table tm-ins-table--gaps">
              <caption className="tm-visually-hidden">
                {t('InsightsAdoptionScreen.gapsCaption')}
              </caption>
              <thead>
                <tr>
                  <th scope="col">{t('InsightsAdoptionScreen.colGap')}</th>
                  <th scope="col">{t('InsightsAdoptionScreen.colWhere')}</th>
                  <th scope="col" className="tm-ins-table__num">
                    {t('InsightsAdoptionScreen.colItems')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {adoption.gaps.map((gap) => (
                  <tr key={gap.id} data-tone={gap.count > 0 ? 'warning' : 'quiet'}>
                    <th scope="row">
                      {t(GAP_COPY[gap.id].titleKey)}
                      <span className="tm-ins-table__sub">{t(GAP_COPY[gap.id].breaksKey)}</span>
                    </th>
                    <td>{where(gap, t)}</td>
                    <td className="tm-ins-table__num">{gap.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </InsightsCard>
        }
        side={
          <>
            <InsightsCard labelledBy="tm-adoption-decisions">
              <InsightsCardHead
                id="tm-adoption-decisions"
                title={t('InsightsAdoptionScreen.decisionsTitle')}
                units={`${t('InsightsAdoptionScreen.lastPrefix')} ${adoption.windowDays} ${t('InsightsAdoptionScreen.daysWord')}`}
              />
              <InsightsBars
                label={t('InsightsAdoptionScreen.barsLabel')}
                bars={[
                  {
                    key: 'log',
                    label: t('InsightsAdoptionScreen.barDecisionLog'),
                    value: decisionsRecorded.decisionLog,
                  },
                  {
                    key: 'approval',
                    label: t('InsightsAdoptionScreen.barApproval'),
                    value: decisionsRecorded.approvals,
                  },
                ]}
              />
              <p className="tm-ins-card__body">
                {decisionsRecorded.decisionLog}{' '}
                {decisionsRecorded.decisionLog === 1
                  ? t('InsightsAdoptionScreen.decisionWas')
                  : t('InsightsAdoptionScreen.decisionsWere')}{' '}
                {t('InsightsAdoptionScreen.loggedAnd')} {decisionsRecorded.approvals}{' '}
                {decisionsRecorded.approvals === 1
                  ? t('InsightsAdoptionScreen.approval')
                  : t('InsightsAdoptionScreen.approvals')}{' '}
                {t('InsightsAdoptionScreen.decidedInLast')} {adoption.windowDays}{' '}
                {t('InsightsAdoptionScreen.daysPeriod')}
              </p>
            </InsightsCard>
            <InsightsCard variant="callout" className="tm-ins-card--fill">
              <p className="tm-ins-eyebrow">{t('InsightsAdoptionScreen.calloutEyebrow')}</p>
              <p className="tm-ins-card__body tm-ins-card__body--lead">
                {t('InsightsAdoptionScreen.calloutBody')}
              </p>
              <div className="tm-ins-callout__actions">
                {totalGaps > 0 ? (
                  <a
                    className="tm-button tm-button--ink tm-ins-callout__primary"
                    href="#tm-adoption-gaps"
                  >
                    {t('InsightsAdoptionScreen.openThe')} {totalGaps}{' '}
                    {totalGaps === 1
                      ? t('InsightsAdoptionScreen.gap')
                      : t('InsightsAdoptionScreen.gaps')}
                  </a>
                ) : (
                  <span className="tm-ins-callout__primary tm-muted">
                    {t('InsightsAdoptionScreen.noGaps')}
                  </span>
                )}
                <Link
                  className="tm-button tm-button--outline"
                  href={`/${organizationSlug}/policies`}
                >
                  {t('InsightsAdoptionScreen.policy')}
                </Link>
              </div>
            </InsightsCard>
          </>
        }
      />
    </>
  );
}

/** "5–18 October" — the window ending at `computedAt`, as the frame's eyebrow shows it. */
export function windowLabel(computedAt: string, windowDays: number): string {
  const end = new Date(computedAt);
  if (Number.isNaN(end.getTime())) return `Last ${windowDays} days`;
  const start = new Date(end.getTime() - (windowDays - 1) * 86_400_000);
  const day = new Intl.DateTimeFormat('en-GB', { day: 'numeric' });
  const dayMonth = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long' });
  return start.getMonth() === end.getMonth()
    ? `${day.format(start)}–${dayMonth.format(end)}`
    : `${dayMonth.format(start)} – ${dayMonth.format(end)}`;
}

/** Turn a thrown value into a sentence a person can act on. Never leaks a stack or a cause. */
function describe(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Check that it is running.';
  return 'Something went wrong. Try again.';
}

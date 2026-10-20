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
          ? `Insights · Adoption and system quality · Workspace admin · ${windowLabel(
              adoption.data.computedAt,
              adoption.data.windowDays,
            )}`
          : 'Insights · Adoption and system quality · Workspace admin'
      }
      title="Can we trust what this shows"
      actions={
        <>
          <Link className="tm-button tm-button--outline" href={`/${organizationSlug}/settings`}>
            Workspace
          </Link>
          <a className="tm-button tm-button--ink" href="#tm-adoption-gaps">
            Fix data gaps
          </a>
        </>
      }
    >
      <div className="tm-ins">
        <InsightsTabs organizationSlug={organizationSlug} current="adoption" />

        {adoption.isPending ? (
          <LoadingRegion label="Loading adoption metrics." className="tm-stack tm-stack--tight">
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {adoption.isError ? (
          <InlineAlert tone="danger" title="Could not load the adoption metrics" live>
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

/** Each data gap's row copy: what is missing, and what it breaks. */
const GAP_COPY: Readonly<Record<AdoptionGapId, { title: string; breaks: string }>> = {
  chat_work_untriaged: {
    title: 'Work created from chat without triage',
    breaks: 'no owner, no date — absent from every forecast',
  },
  client_files_internal: {
    title: 'Files shared with a client still marked internal',
    breaks: 'nobody can tell internal from client visible',
  },
  requests_uncommitted: {
    title: 'Requests with a desired date and no committed answer',
    breaks: 'the client is waiting on a yes we never said',
  },
};

function percent(part: number, whole: number): number | undefined {
  return whole === 0 ? undefined : Math.round((part / whole) * 100);
}

function where(gap: InsightsAdoptionGapView): string {
  if (gap.projectCount === 0) return '—';
  if (gap.projectCount === 1) return gap.projectName ?? '1 project';
  return `${gap.projectCount} projects`;
}

function AdoptionReport({
  adoption,
  organizationSlug,
}: {
  adoption: InsightsAdoptionView;
  organizationSlug: string;
}) {
  const { committedDate, channels, unhashedDeliverables, decisionsRecorded } = adoption;
  const dated = percent(committedDate.dated, committedDate.total);
  const datedBefore = percent(committedDate.previousDated, committedDate.previousTotal);
  const hashDelta = unhashedDeliverables.previous - unhashedDeliverables.current;
  const totalGaps = adoption.gaps.reduce((sum, gap) => sum + gap.count, 0);

  return (
    <>
      <InsightsMetrics label="Adoption headline figures">
        <InsightsMetric
          value={dated === undefined ? '—' : `${dated}%`}
          {...(datedBefore === undefined ? {} : { badge: `was ${datedBefore}%` })}
          badgeTone={
            dated !== undefined && datedBefore !== undefined && dated < datedBefore
              ? 'warning'
              : 'quiet'
          }
          label="of work items carry a committed date"
          note="the rest cannot appear in any forecast"
        />
        <InsightsMetric
          value={channels.withoutWork}
          badge={`of ${channels.total}`}
          label="channels with no work item ever created from them"
          note="decisions there are not being captured"
        />
        <InsightsMetric
          value={unhashedDeliverables.current}
          {...(hashDelta === 0
            ? {}
            : { badge: hashDelta > 0 ? `down ${hashDelta}` : `up ${-hashDelta}` })}
          badgeTone={hashDelta > 0 ? 'lime' : 'warning'}
          label="deliverables sent without a tracked version"
          note="approval cannot be tied to a specific file"
        />
      </InsightsMetrics>

      <InsightsSplit
        main={
          <InsightsCard variant="table" id="tm-adoption-gaps" label="Data gaps">
            <table className="tm-ins-table tm-ins-table--gaps">
              <caption className="tm-visually-hidden">
                Data gaps that make the record unreliable
              </caption>
              <thead>
                <tr>
                  <th scope="col">Data gap · What it breaks</th>
                  <th scope="col">Where</th>
                  <th scope="col" className="tm-ins-table__num">
                    Items
                  </th>
                </tr>
              </thead>
              <tbody>
                {adoption.gaps.map((gap) => (
                  <tr key={gap.id} data-tone={gap.count > 0 ? 'warning' : 'quiet'}>
                    <th scope="row">
                      {GAP_COPY[gap.id].title}
                      <span className="tm-ins-table__sub">{GAP_COPY[gap.id].breaks}</span>
                    </th>
                    <td>{where(gap)}</td>
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
                title="Where decisions get recorded"
                units={`Last ${adoption.windowDays} days`}
              />
              <InsightsBars
                label="Decisions by where they were recorded"
                bars={[
                  { key: 'log', label: 'Decision log', value: decisionsRecorded.decisionLog },
                  { key: 'approval', label: 'Approval', value: decisionsRecorded.approvals },
                ]}
              />
              <p className="tm-ins-card__body">
                {decisionsRecorded.decisionLog}{' '}
                {decisionsRecorded.decisionLog === 1 ? 'decision was' : 'decisions were'} logged and{' '}
                {decisionsRecorded.approvals}{' '}
                {decisionsRecorded.approvals === 1 ? 'approval' : 'approvals'} decided in the last{' '}
                {adoption.windowDays} days.
              </p>
            </InsightsCard>
            <InsightsCard variant="callout" className="tm-ins-card--fill">
              <p className="tm-ins-eyebrow">Adoption, measured honestly</p>
              <p className="tm-ins-card__body tm-ins-card__body--lead">
                Adoption here means whether the record is complete enough to be relied on. It is not
                a login count and it is not attributed to individuals.
              </p>
              <div className="tm-ins-callout__actions">
                {totalGaps > 0 ? (
                  <a
                    className="tm-button tm-button--ink tm-ins-callout__primary"
                    href="#tm-adoption-gaps"
                  >
                    Open the {totalGaps} {totalGaps === 1 ? 'gap' : 'gaps'}
                  </a>
                ) : (
                  <span className="tm-ins-callout__primary tm-muted">No data gaps right now.</span>
                )}
                <Link
                  className="tm-button tm-button--outline"
                  href={`/${organizationSlug}/policies`}
                >
                  Policy
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

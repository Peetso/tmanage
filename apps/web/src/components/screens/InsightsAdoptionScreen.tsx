'use client';

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
import type { InsightsAdoptionView } from '../../lib/api/insights-adoption';
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
 * renders the three org-level facts as an accessible read-only table: how many people hold an active
 * membership, how many of them created work in the window, and how many meetings the studio held in
 * it.
 *
 * The decisions are the sibling insights screens':
 * 1. **Authorization is the API's.** A caller without `work.read` gets the ordinary 403, which
 *    `describe()` turns into a sentence in the panel's own alert; the screen never guesses a
 *    capability of its own and never renders blank on a refusal.
 * 2. **No invented numbers.** The counts are the API's; the window they were computed over is shown
 *    plainly rather than assumed.
 * 3. **No charts dependency.** A semantic table with a caption and row scope carries the data; a11y
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
    queryFn: () => fetchOrgAdoption(api, organizationSlug),
  });

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="insights"
      eyebrow={
        adoption.data
          ? `Insights · Adoption and system quality · Last ${adoption.data.windowDays} days`
          : 'Insights · Adoption and system quality'
      }
      title="Can we trust what this shows"
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

        {adoption.isSuccess ? <AdoptionReport adoption={adoption.data} /> : null}
      </div>
    </AppShell>
  );
}

/** The metrics in the order they are shown, keyed to the fields the API returns. */
const METRICS: readonly { id: keyof AdoptionCounts; label: string; short: string }[] = [
  { id: 'activeMembers', label: 'Active members', short: 'Active members' },
  { id: 'membersWithWork', label: 'Members who created work', short: 'Created work' },
  { id: 'meetingsHeld', label: 'Meetings held', short: 'Meetings held' },
];

type AdoptionCounts = Pick<
  InsightsAdoptionView,
  'activeMembers' | 'membersWithWork' | 'meetingsHeld'
>;

function AdoptionReport({ adoption }: { adoption: InsightsAdoptionView }) {
  const share =
    adoption.activeMembers === 0
      ? undefined
      : Math.round((adoption.membersWithWork / adoption.activeMembers) * 100);

  return (
    <>
      <InsightsMetrics label="Adoption headline figures">
        <InsightsMetric
          value={share === undefined ? '—' : `${share}%`}
          badge={`${adoption.membersWithWork} of ${adoption.activeMembers}`}
          badgeTone={share !== undefined && share < 50 ? 'warning' : 'quiet'}
          label="of active members created work"
          note="the rest cannot appear in any forecast"
        />
        <InsightsMetric
          value={adoption.activeMembers}
          label="members active"
          note={`over the last ${adoption.windowDays} days`}
        />
        <InsightsMetric
          value={adoption.meetingsHeld}
          label="meetings held"
          note="each one a place a decision can be recorded"
        />
      </InsightsMetrics>

      <InsightsSplit
        main={
          <InsightsCard variant="table" labelledBy="tm-adoption-heading">
            <div className="tm-ins-card__lead">
              <InsightsCardHead
                id="tm-adoption-heading"
                title="Adoption"
                units={`Last ${adoption.windowDays} days`}
              />
            </div>
            <table className="tm-ins-table">
              <caption className="tm-visually-hidden">
                Organization adoption over the last {adoption.windowDays} days
              </caption>
              <thead>
                <tr>
                  <th scope="col">Metric</th>
                  <th scope="col" className="tm-ins-table__num">
                    Count
                  </th>
                </tr>
              </thead>
              <tbody>
                {METRICS.map(({ id, label }) => (
                  <tr key={id} data-tone={adoption[id] === 0 ? 'warning' : 'quiet'}>
                    <th scope="row">{label}</th>
                    <td className="tm-ins-table__num">{adoption[id]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="tm-ins-card__foot">
              Activity is counted over the last {adoption.windowDays} days. Computed{' '}
              {formatMoment(adoption.computedAt)}.
            </p>
          </InsightsCard>
        }
        side={
          <>
            <InsightsCard labelledBy="tm-adoption-bars">
              <InsightsCardHead
                id="tm-adoption-bars"
                title="Where the record is fed"
                units={`Last ${adoption.windowDays} days`}
              />
              <InsightsBars
                label="Adoption counts"
                bars={METRICS.map(({ id, short }) => ({
                  key: id,
                  label: short,
                  value: adoption[id],
                  ...(id === 'membersWithWork' ? { tone: 'lime' as const, emphasis: true } : {}),
                }))}
              />
            </InsightsCard>
            <InsightsCard variant="callout">
              <p className="tm-ins-eyebrow">Adoption, measured honestly</p>
              <p className="tm-ins-card__body">
                Adoption here means whether the record is complete enough to be relied on. It is not
                a login count and it is not attributed to individuals.
              </p>
            </InsightsCard>
          </>
        }
      />
    </>
  );
}

/** Turn a thrown value into a sentence a person can act on. Never leaks a stack or a cause. */
function describe(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Check that it is running.';
  return 'Something went wrong. Try again.';
}

/**
 * Format an ISO timestamp for display, following the browser's locale for the reason
 * `SessionsScreen` gives. An unparseable value is shown verbatim rather than as `Invalid Date`.
 */
function formatMoment(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(at);
}

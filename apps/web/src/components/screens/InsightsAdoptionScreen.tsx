'use client';

import { useQuery } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
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
      title="Adoption"
      description="How much of the studio is actually using the product."
    >
      <section className="tm-panel tm-stack" aria-labelledby="tm-adoption-heading">
        <h2 id="tm-adoption-heading" className="tm-eyebrow">
          Adoption
        </h2>

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

        {adoption.isSuccess ? <AdoptionTable adoption={adoption.data} /> : null}
      </section>
    </AppShell>
  );
}

/** The metrics in the order they are shown, keyed to the fields the API returns. */
const METRICS: readonly { id: keyof AdoptionCounts; label: string }[] = [
  { id: 'activeMembers', label: 'Active members' },
  { id: 'membersWithWork', label: 'Members who created work' },
  { id: 'meetingsHeld', label: 'Meetings held' },
];

type AdoptionCounts = Pick<
  InsightsAdoptionView,
  'activeMembers' | 'membersWithWork' | 'meetingsHeld'
>;

function AdoptionTable({ adoption }: { adoption: InsightsAdoptionView }) {
  return (
    <>
      <table className="tm-table">
        <caption className="tm-visually-hidden">
          Organization adoption over the last {adoption.windowDays} days
        </caption>
        <thead>
          <tr>
            <th scope="col">Metric</th>
            <th scope="col" className="tm-table__number">
              Count
            </th>
          </tr>
        </thead>
        <tbody>
          {METRICS.map(({ id, label }) => (
            <tr key={id}>
              <th scope="row">{label}</th>
              <td className="tm-mono tm-table__number">{adoption[id]}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="tm-prose">Activity is counted over the last {adoption.windowDays} days.</p>
      <p className="tm-prose tm-mono">Computed {formatMoment(adoption.computedAt)}.</p>
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

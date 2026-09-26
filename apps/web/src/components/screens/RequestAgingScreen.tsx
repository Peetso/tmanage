'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { fetchRequestAging } from '../../lib/api/request-aging';
import type { RequestAgingItem, RequestAgingView } from '../../lib/api/request-aging';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface RequestAgingScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** Injected in tests. Defaults to the browser client. */
  client?: ApiClient;
}

/**
 * **Request aging** — module 11 (x154), the studio's overdue-to-triage / long-uncommitted view turned
 * into a proven screen. It reads `GET /v1/organizations/:orgSlug/client-requests/aging` (gated on the
 * server by `client_request.triage`) and renders the aging buckets, their counts, and a bounded,
 * oldest-first list of the open requests, each linking through to the triage inbox.
 *
 * The decisions are the sibling read screens':
 * 1. **Authorization is the API's.** A caller without `client_request.triage` gets the ordinary 403,
 *    which `describe()` turns into a sentence in the panel's own alert; the screen never guesses a
 *    capability of its own and never renders blank on a refusal.
 * 2. **No invented numbers.** The counts and thresholds are the API's; the day boundaries the buckets
 *    were chosen against are shown plainly rather than assumed.
 * 3. **No charts dependency.** A semantic table with a caption and row scope carries the data; a11y is
 *    checked against the mounted document, not asserted.
 */
export function RequestAgingScreen({
  organizationSlug,
  organizationName,
  client,
}: RequestAgingScreenProps) {
  const api = client ?? browserApiClient();

  const aging = useQuery({
    queryKey: ['request-aging', organizationSlug],
    queryFn: () => fetchRequestAging(api, organizationSlug),
  });

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="work"
      title="Request aging"
      description="How long open client requests have been waiting to be triaged."
    >
      <section className="tm-panel tm-stack" aria-labelledby="tm-request-aging-heading">
        <h2 id="tm-request-aging-heading" className="tm-eyebrow">
          Request aging
        </h2>

        {aging.isPending ? (
          <LoadingRegion label="Loading request aging." className="tm-stack tm-stack--tight">
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {aging.isError ? (
          <InlineAlert tone="danger" title="Could not load request aging" live>
            {describe(aging.error)}
          </InlineAlert>
        ) : null}

        {aging.isSuccess ? (
          <AgingReport aging={aging.data} organizationSlug={organizationSlug} />
        ) : null}
      </section>
    </AppShell>
  );
}

/** The buckets in the order they are shown, keyed to the fields the API returns. */
const BUCKETS: readonly { id: 'fresh' | 'aging' | 'overdue'; label: string }[] = [
  { id: 'fresh', label: 'Fresh' },
  { id: 'aging', label: 'Aging' },
  { id: 'overdue', label: 'Overdue' },
];

function AgingReport({
  aging,
  organizationSlug,
}: {
  aging: RequestAgingView;
  organizationSlug: string;
}) {
  const { thresholds, counts, requests } = aging;
  return (
    <>
      <table className="tm-table">
        <caption className="tm-visually-hidden">
          Open client requests by age: fresh under {thresholds.agingDays} days, aging under{' '}
          {thresholds.overdueDays} days, overdue at or beyond {thresholds.overdueDays} days
        </caption>
        <thead>
          <tr>
            <th scope="col">Bucket</th>
            <th scope="col" className="tm-table__number">
              Count
            </th>
          </tr>
        </thead>
        <tbody>
          {BUCKETS.map(({ id, label }) => (
            <tr key={id}>
              <th scope="row">{label}</th>
              <td className="tm-mono tm-table__number">{counts[id]}</td>
            </tr>
          ))}
          <tr>
            <th scope="row">Uncommitted</th>
            <td className="tm-mono tm-table__number">{counts.uncommitted}</td>
          </tr>
          <tr>
            <th scope="row">Total open</th>
            <td className="tm-mono tm-table__number">{counts.total}</td>
          </tr>
        </tbody>
      </table>

      <p className="tm-prose">
        Fresh is under {thresholds.agingDays} days old; aging is under {thresholds.overdueDays}{' '}
        days; overdue is {thresholds.overdueDays} days or more.
      </p>

      {requests.length === 0 ? (
        <InlineAlert tone="neutral" title="Nothing is waiting">
          No open client request is currently aging.
        </InlineAlert>
      ) : (
        <table className="tm-table">
          <caption className="tm-visually-hidden">
            Open client requests, oldest first, with age and bucket
          </caption>
          <thead>
            <tr>
              <th scope="col">Request</th>
              <th scope="col">Bucket</th>
              <th scope="col" className="tm-table__number">
                Age (days)
              </th>
              <th scope="col">Committed</th>
            </tr>
          </thead>
          <tbody>
            {requests.map((request) => (
              <AgingRow key={request.id} request={request} organizationSlug={organizationSlug} />
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function AgingRow({
  request,
  organizationSlug,
}: {
  request: RequestAgingItem;
  organizationSlug: string;
}) {
  return (
    <tr>
      <th scope="row">
        <Link href={`/${organizationSlug}/work/requests/${request.id}`}>{request.title}</Link>
      </th>
      <td>{BUCKET_LABELS[request.bucket]}</td>
      <td className="tm-mono tm-table__number">{request.ageDays}</td>
      <td>{request.committed ? 'Yes' : 'No'}</td>
    </tr>
  );
}

const BUCKET_LABELS: Record<RequestAgingItem['bucket'], string> = {
  fresh: 'Fresh',
  aging: 'Aging',
  overdue: 'Overdue',
};

/** Turn a thrown value into a sentence a person can act on. Never leaks a stack or a cause. */
function describe(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Check that it is running.';
  return 'Something went wrong. Try again.';
}

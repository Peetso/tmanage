'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Announce, Button, InlineAlert, LoadingRegion, Skeleton, StateCapsule } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { BackendPending } from './BackendPending';
import { browserApiClient } from '../../lib/api/browser-client';
import { MAX_CLIENT_REQUEST_PAGE, listClientRequestRecords } from '../../lib/api/client-requests';
import type { ClientRequestRecord } from '../../lib/api/client-requests';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import {
  TRIAGE_BUCKETS,
  bucketOf,
  describeAge,
  formatDay,
  triageStateCapsule,
  triageStateLabel,
} from '../../lib/triage-presentation';
import type { TriageBucketId } from '../../lib/triage-presentation';

export interface RequestInboxScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
  /** Injected in tests so "age" is measured against a fixed moment. */
  now?: Date;
}

/**
 * **REQ-01 Request inbox** — `41-WHOLE-APP-SCREEN-AND-STATE-MATRIX` §8, and the first half of
 * `WEB-005 manager triage screen and schedule impact`.
 *
 * The design artifact puts it under **Work · Requests**, which settles a question the
 * specification does not answer directly: `22-SCREEN-BY-SCREEN` §1 fixes the internal rail at
 * eight destinations and Requests is not one of them, so the inbox lives under `Work` and is
 * reached from `TM-03`. No rail item was invented, exactly as none was on the client side.
 *
 * ## The counts are the screen
 *
 * The artifact leads with "18 total · New · 2 · Clarifying · 1 · Accepted · 9 · Deferred · 4 ·
 * Declined · 2", and that row is what a manager opens this page for: whether anything is waiting
 * on **them**. Everything below it is the same list filtered.
 *
 * `withdrawn` is counted under Declined rather than given a bucket of its own. It is an ending
 * the client caused, it needs no action, and a sixth number for a rare case would make the row
 * harder to read for no gain — the state capsule on the row still says "Withdrawn", so nothing
 * is hidden.
 *
 * ## Sorted by age, because age is the only fact
 *
 * Nothing in this system ranks importance. A queue sorted by anything but how long somebody has
 * been waiting would be sorted by a judgement no column carries.
 */
export function RequestInboxScreen({
  organizationSlug,
  organizationName,
  client,
  now = new Date(),
}: RequestInboxScreenProps) {
  const api = client ?? browserApiClient();
  const [bucket, setBucket] = useState<TriageBucketId | 'all'>('all');

  /*
   * Paged on the API's `after` id cursor — WEB-002's second half. This screen used to ask
   * for the first 200 and show them as though they were everything; now a full page keeps a
   * "Load more" on screen, and the total above the buckets says "loaded" while more exist.
   */
  const requests = useInfiniteQuery({
    queryKey: ['client-requests', organizationSlug],
    queryFn: ({ pageParam }) =>
      listClientRequestRecords(api, organizationSlug, {
        limit: MAX_CLIENT_REQUEST_PAGE,
        ...(pageParam === undefined ? {} : { after: pageParam }),
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) =>
      lastPage.length === MAX_CLIENT_REQUEST_PAGE ? lastPage[lastPage.length - 1]?.id : undefined,
  });

  const all = requests.data?.pages.flat() ?? [];
  const shown = (bucket === 'all' ? all : all.filter((row) => bucketOf(row.state) === bucket))
    .slice()
    .sort(oldestFirst);

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="work"
      title="Request inbox"
      description={`What ${organizationName}'s clients have asked for.`}
    >
      {requests.isError ? (
        <InlineAlert tone="danger" title="Could not load the request inbox" live>
          {describe(requests.error)}
        </InlineAlert>
      ) : null}

      {requests.isPending ? (
        <LoadingRegion label="Loading requests.">
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      <section className="tm-panel tm-stack" aria-labelledby="tm-inbox-counts">
        {/*
          "in total" only when it is the total. With a further page unloaded, the honest word
          is "loaded" — the counts beneath are counts of what is on screen, not of the queue.
        */}
        <h2 id="tm-inbox-counts" className="tm-eyebrow">
          {all.length} {all.length === 1 ? 'request' : 'requests'}{' '}
          {requests.hasNextPage ? 'loaded — there are more' : 'in total'}
        </h2>
        <div className="tm-row tm-row--wrap" role="group" aria-label="Filter by state">
          <FilterButton
            id="all"
            label="All"
            count={all.length}
            active={bucket === 'all'}
            onSelect={setBucket}
          />
          {TRIAGE_BUCKETS.map((candidate) => (
            <FilterButton
              key={candidate.id}
              id={candidate.id}
              label={candidate.label}
              count={all.filter((row) => bucketOf(row.state) === candidate.id).length}
              active={bucket === candidate.id}
              onSelect={setBucket}
            />
          ))}
        </div>
      </section>

      {!requests.isPending && !requests.isError && all.length === 0 ? (
        <InlineAlert tone="neutral" title="No client has asked for anything yet">
          <p className="tm-prose">
            Requests arrive here when a client submits one from their portal. Nothing has to be set
            up for that — every client role can already do it.
          </p>
        </InlineAlert>
      ) : null}

      {shown.length > 0 ? (
        <div
          className="tm-table-scroll"
          // A scrollable region must be focusable or a keyboard cannot reach its overflow
          // columns (WCAG 2.2 2.1.1); the .tm-table-scroll CSS comment states the same.
          // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
          tabIndex={0}
          role="region"
          aria-label="Client requests"
        >
          <table className="tm-table">
            <caption className="tm-visually-hidden">
              Client requests, oldest first. Each row links to its triage page.
            </caption>
            <thead>
              <tr>
                <th scope="col">Request</th>
                <th scope="col">State</th>
                <th scope="col">Desired</th>
                <th scope="col">Age</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((request) => (
                <tr key={request.id}>
                  <th scope="row">
                    <Link href={`/${organizationSlug}/work/requests/${request.id}`}>
                      {request.title}
                    </Link>
                    <span className="tm-field__hint">
                      {/*
                      The client organization's name, which a manager could not look up: the
                      endpoint that lists them is gated on `org.manage`. The API puts it on the
                      internal projection for exactly this row.
                    */}
                      {request.clientOrganizationName ?? 'A client of this organization'}
                    </span>
                  </th>
                  <td>
                    <StateCapsule state={triageStateCapsule(request.state)}>
                      {triageStateLabel(request.state)}
                    </StateCapsule>
                  </td>
                  <td>{request.desiredAt === null ? 'not set' : formatDay(request.desiredAt)}</td>
                  <td>{describeAge(request.createdAt, now)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {!requests.isPending && all.length > 0 && shown.length === 0 ? (
        <p className="tm-prose">Nothing in that state.</p>
      ) : null}

      {requests.hasNextPage ? (
        <div className="tm-row">
          <Button
            tone="outline"
            size="accessible"
            loading={requests.isFetchingNextPage}
            loadingLabel="Loading more"
            onClick={() => void requests.fetchNextPage()}
          >
            Load more
          </Button>
        </div>
      ) : null}

      {/*
        WCAG 2.2 4.1.3: announce the running total when "Load more" appends rows to a table that
        is in no live region, so a screen-reader user knows the press landed.
      */}
      <Announce
        message={
          (requests.data?.pages.length ?? 0) > 1 && !requests.isFetchingNextPage
            ? `${all.length} ${all.length === 1 ? 'request' : 'requests'} loaded in total.`
            : ''
        }
      />

      <BackendPending ticket="PEOPLE · FILE-001">
        The artifact names the person who submitted each request beside their company. Nothing
        returns a person&rsquo;s name in this system yet, so the row carries the company only.
        Attachments are not built either, so a request with files looks the same as one without.
      </BackendPending>
    </AppShell>
  );
}

interface FilterButtonProps {
  id: TriageBucketId | 'all';
  label: string;
  count: number;
  active: boolean;
  onSelect: (id: TriageBucketId | 'all') => void;
}

/**
 * A filter, and a count, in one control.
 *
 * `aria-pressed` rather than a tab set: these filter a table that is already on the page, and a
 * tab implies a panel swap. The count is inside the accessible name, so a screen reader hears
 * "Needs triage, 2" rather than the number arriving as unattached text after it.
 */
function FilterButton({ id, label, count, active, onSelect }: FilterButtonProps) {
  return (
    <button
      type="button"
      className="tm-button tm-button--outline"
      aria-pressed={active}
      onClick={() => onSelect(id)}
    >
      {label} · {count}
    </button>
  );
}

/** Oldest first. Age is the only urgency signal any column on this screen actually carries. */
function oldestFirst(left: ClientRequestRecord, right: ClientRequestRecord): number {
  if (left.createdAt === right.createdAt) return 0;
  return left.createdAt < right.createdAt ? -1 : 1;
}

function describe(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}

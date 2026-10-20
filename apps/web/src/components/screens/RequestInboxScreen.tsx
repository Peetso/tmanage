'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Announce, Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { useT } from '../../lib/i18n/use-t';
import { MAX_CLIENT_REQUEST_PAGE, listClientRequestRecords } from '../../lib/api/client-requests';
import type { ClientRequestRecord } from '../../lib/api/client-requests';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import {
  TRIAGE_BUCKETS,
  bucketOf,
  describeAge,
  formatDay,
  triageStateLabel,
} from '../../lib/triage-presentation';
import type { TriageBucketId } from '../../lib/triage-presentation';
import '../../styles/screens/work-planning.css';

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
  const t = useT();
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
      title={t('RequestInboxScreen.title')}
      eyebrow={t('RequestInboxScreen.eyebrow')}
      headerAside={
        <span className="wp-total" aria-hidden="true">
          {all.length}{' '}
          {requests.hasNextPage ? t('RequestInboxScreen.loaded') : t('RequestInboxScreen.total')}
        </span>
      }
    >
      {/*
        "in total" only when it is the total. With a further page unloaded, the honest word is
        "loaded" — the counts beneath are counts of what is on screen, not of the queue. The
        visible "18 total" beside the title is the artboard's; this heading says it in full.
      */}
      <h2 id="tm-inbox-counts" className="tm-visually-hidden">
        {all.length} {all.length === 1 ? 'request' : 'requests'}{' '}
        {requests.hasNextPage ? 'loaded — there are more' : 'in total'}
      </h2>
      <div className="wp-chips" role="group" aria-label={t('RequestInboxScreen.filterByState')}>
        <FilterButton
          id="all"
          label={t('RequestInboxScreen.filterAll')}
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

      {requests.isError ? (
        <InlineAlert tone="danger" title={t('RequestInboxScreen.loadFailed')} live>
          {describe(requests.error)}
        </InlineAlert>
      ) : null}

      {requests.isPending ? (
        <LoadingRegion label={t('RequestInboxScreen.loading')}>
          <Skeleton height="46px" />
          <Skeleton height="46px" />
          <Skeleton height="46px" />
        </LoadingRegion>
      ) : null}

      {!requests.isPending && !requests.isError && all.length === 0 ? (
        <div className="wp-empty">
          <h2 className="wp-empty__title">{t('RequestInboxScreen.emptyTitle')}</h2>
          <p className="wp-empty__body">{t('RequestInboxScreen.emptyBody')}</p>
        </div>
      ) : null}

      {shown.length > 0 ? (
        <div
          className="wp-rows"
          // A scrollable region must be focusable or a keyboard cannot reach its overflow
          // columns (WCAG 2.2 2.1.1).
          // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
          tabIndex={0}
          role="region"
          aria-label={t('RequestInboxScreen.clientRequests')}
        >
          <table>
            <caption className="tm-visually-hidden">{t('RequestInboxScreen.caption')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('RequestInboxScreen.colRequest')}</th>
                <th scope="col" className="wp-col-state">
                  {t('RequestInboxScreen.colState')}
                </th>
                <th scope="col" className="wp-col-desired wp-hide-sm">
                  {t('RequestInboxScreen.colDesired')}
                </th>
                <th scope="col" className="wp-col-age wp-num">
                  {t('RequestInboxScreen.colAge')}
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((request, index) => {
                const rowBucket = bucketOf(request.state);
                const actionable = rowBucket === 'new';
                const rowClass = [
                  index === 0 && actionable ? 'wp-row--first' : '',
                  rowBucket === 'declined' ? 'wp-row--ended' : '',
                ]
                  .filter(Boolean)
                  .join(' ');
                return (
                  <tr key={request.id} className={rowClass === '' ? undefined : rowClass}>
                    <th scope="row">
                      <Link
                        className="wp-row-title"
                        href={`/${organizationSlug}/work/requests/${request.id}`}
                      >
                        {request.title}
                      </Link>
                      <span className="wp-row-sub">
                        {/*
                          The client organization's name, which a manager could not look up: the
                          endpoint that lists them is gated on `org.manage`. The API puts it on
                          the internal projection for exactly this row.
                        */}
                        {request.clientOrganizationName ?? t('RequestInboxScreen.aClient')}
                      </span>
                    </th>
                    <td>
                      <span className={`wp-pill ${PILL_CLASS[rowBucket]}`}>
                        {triageStateLabel(request.state)}
                      </span>
                    </td>
                    <td className="wp-hide-sm">
                      <span
                        className={
                          request.desiredAt !== null && actionable
                            ? 'wp-row-mono wp-row-mono--warn'
                            : 'wp-row-mono'
                        }
                      >
                        {request.desiredAt === null
                          ? t('RequestInboxScreen.notSet')
                          : formatDay(request.desiredAt)}
                      </span>
                    </td>
                    <td className="wp-num">
                      <span
                        className={actionable ? 'wp-row-mono wp-row-mono--warn' : 'wp-row-mono'}
                      >
                        {describeAge(request.createdAt, now)}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}

      {!requests.isPending && all.length > 0 && shown.length === 0 ? (
        <div className="wp-empty">
          <p className="wp-empty__body">{t('RequestInboxScreen.nothingInState')}</p>
        </div>
      ) : null}

      {requests.hasNextPage ? (
        <div className="tm-row">
          <Button
            tone="outline"
            size="accessible"
            loading={requests.isFetchingNextPage}
            loadingLabel={t('RequestInboxScreen.loadingMore')}
            onClick={() => void requests.fetchNextPage()}
          >
            {t('RequestInboxScreen.loadMore')}
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
    </AppShell>
  );
}

/** REQ-01's pills: lime for the studio's own queue, outline while waiting, grey for an ending. */
const PILL_CLASS: Record<TriageBucketId, string> = {
  new: 'wp-pill--new',
  clarifying: '',
  accepted: '',
  deferred: '',
  declined: 'wp-pill--ended',
};

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
    <button type="button" className="tm-chip" aria-pressed={active} onClick={() => onSelect(id)}>
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

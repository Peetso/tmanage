'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { useT } from '../../lib/i18n/use-t';
import type { MessageKey } from '../../lib/i18n/t';
import { fetchRequestAging } from '../../lib/api/request-aging';
import type { RequestAgingItem, RequestAgingView } from '../../lib/api/request-aging';
import { useDescribeApiError } from '../../lib/api/describe-error';
import type { ApiClient } from '../../lib/api/client';
import '../../styles/screens/work-planning.css';

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
  const describe = useDescribeApiError();
  const api = client ?? browserApiClient();
  const t = useT();

  const aging = useQuery({
    queryKey: ['request-aging', organizationSlug],
    queryFn: () => fetchRequestAging(api, organizationSlug),
  });

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="work"
      title={t('RequestAgingScreen.title')}
      eyebrow={t('RequestAgingScreen.eyebrow')}
      headerAside={
        aging.isSuccess ? (
          <span className="wp-total" aria-hidden="true">
            {aging.data.counts.total}
            {t('RequestAgingScreen.openSuffix')}
          </span>
        ) : undefined
      }
      actions={
        <Link className="wp-capsule" href={`/${organizationSlug}/work/requests`}>
          {t('RequestAgingScreen.requestInbox')}
        </Link>
      }
    >
      <h2 id="tm-request-aging-heading" className="tm-visually-hidden">
        {t('RequestAgingScreen.title')}
      </h2>

      {aging.isPending ? (
        <LoadingRegion label={t('RequestAgingScreen.loading')} className="tm-stack tm-stack--tight">
          <Skeleton height="46px" />
          <Skeleton height="46px" />
        </LoadingRegion>
      ) : null}

      {aging.isError ? (
        <InlineAlert tone="danger" title={t('RequestAgingScreen.loadFailed')} live>
          {describe(aging.error)}
        </InlineAlert>
      ) : null}

      {aging.isSuccess ? (
        <AgingReport aging={aging.data} organizationSlug={organizationSlug} />
      ) : null}
    </AppShell>
  );
}

const BUCKET_IDS: readonly ('fresh' | 'aging' | 'overdue')[] = ['fresh', 'aging', 'overdue'];

const BUCKET_KEY: Record<RequestAgingItem['bucket'], MessageKey> = {
  fresh: 'RequestAgingScreen.bucketFresh',
  aging: 'RequestAgingScreen.bucketAging',
  overdue: 'RequestAgingScreen.bucketOverdue',
};

/**
 * The counts summary and the per-request list, in REQ-01's row grammar: a quiet bordered table,
 * mono headers and numbers, the overdue figures in warning orange.
 */
function AgingReport({
  aging,
  organizationSlug,
}: {
  aging: RequestAgingView;
  organizationSlug: string;
}) {
  const t = useT();
  const { thresholds, counts, requests } = aging;
  return (
    <div className="wp-aging-grid">
      <div className="wp-stack">
        <div className="wp-rows">
          <table>
            <caption className="tm-visually-hidden">
              Open client requests by age: fresh under {thresholds.agingDays} days, aging under{' '}
              {thresholds.overdueDays} days, overdue at or beyond {thresholds.overdueDays} days
            </caption>
            <thead>
              <tr>
                <th scope="col">{t('RequestAgingScreen.colBucket')}</th>
                <th scope="col" className="wp-num">
                  {t('RequestAgingScreen.colCount')}
                </th>
              </tr>
            </thead>
            <tbody>
              {BUCKET_IDS.map((id) => (
                <tr key={id}>
                  <th scope="row">
                    <span className="wp-row-title">{t(BUCKET_KEY[id])}</span>
                  </th>
                  <td className="wp-num">
                    <span
                      className={
                        id === 'overdue' && counts[id] > 0
                          ? 'wp-row-mono wp-row-mono--warn'
                          : 'wp-row-mono'
                      }
                    >
                      {counts[id]}
                    </span>
                  </td>
                </tr>
              ))}
              <tr>
                <th scope="row">
                  <span className="wp-row-title">{t('RequestAgingScreen.rowUncommitted')}</span>
                </th>
                <td className="wp-num">
                  <span className="wp-row-mono">{counts.uncommitted}</span>
                </td>
              </tr>
              <tr className="wp-row--first">
                <th scope="row">
                  <span className="wp-row-title">{t('RequestAgingScreen.rowTotalOpen')}</span>
                </th>
                <td className="wp-num">
                  <span className="wp-row-mono">{counts.total}</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="wp-aging-note">
          Fresh is under {thresholds.agingDays} days old; aging is under {thresholds.overdueDays}{' '}
          days; overdue is {thresholds.overdueDays} days or more.
        </p>
      </div>

      {requests.length === 0 ? (
        <div className="wp-empty">
          <h3 className="wp-empty__title">{t('RequestAgingScreen.emptyTitle')}</h3>
          <p className="wp-empty__body">{t('RequestAgingScreen.emptyBody')}</p>
        </div>
      ) : (
        <div className="wp-rows">
          <table>
            <caption className="tm-visually-hidden">{t('RequestAgingScreen.captionList')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('RequestAgingScreen.colRequest')}</th>
                <th scope="col" className="wp-col-state">
                  {t('RequestAgingScreen.colBucket')}
                </th>
                <th scope="col" className="wp-col-desired wp-num">
                  {t('RequestAgingScreen.colAgeDays')}
                </th>
                <th scope="col" className="wp-col-desired wp-hide-sm">
                  {t('RequestAgingScreen.colCommitted')}
                </th>
              </tr>
            </thead>
            <tbody>
              {requests.map((request) => (
                <AgingRow key={request.id} request={request} organizationSlug={organizationSlug} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function AgingRow({
  request,
  organizationSlug,
}: {
  request: RequestAgingItem;
  organizationSlug: string;
}) {
  const t = useT();
  const overdue = request.bucket === 'overdue';
  return (
    <tr>
      <th scope="row">
        <Link className="wp-row-title" href={`/${organizationSlug}/work/requests/${request.id}`}>
          {request.title}
        </Link>
      </th>
      <td>
        <span className={`wp-pill ${request.bucket === 'fresh' ? 'wp-pill--new' : ''}`}>
          {t(BUCKET_KEY[request.bucket])}
        </span>
      </td>
      <td className="wp-num">
        <span className={overdue ? 'wp-row-mono wp-row-mono--warn' : 'wp-row-mono'}>
          {request.ageDays}
        </span>
      </td>
      <td className="wp-hide-sm">
        <span className="wp-row-mono">
          {request.committed ? t('RequestAgingScreen.yes') : t('RequestAgingScreen.no')}
        </span>
      </td>
    </tr>
  );
}

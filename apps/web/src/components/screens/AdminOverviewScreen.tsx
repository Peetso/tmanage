'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { ControlCenterShell } from '../admin/ControlCenterShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { fetchAdminOverview } from '../../lib/api/admin-overview';
import type { AdminOverviewView } from '../../lib/api/admin-overview';
import { listAuditEvents } from '../../lib/api/admin-audit';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';
import type { MessageKey } from '../../lib/i18n/t';

export interface AdminOverviewScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** Injected in tests. Defaults to the browser client. */
  client?: ApiClient;
}

/**
 * **Control Center home** — ADM-01 "What needs a decision" (module 18, x175). It reads
 * `GET /v1/organizations/:orgSlug/admin/overview` (gated on the server by `org.manage`) and draws the
 * frame: the black "act first" card, the metric cards and the recent-changes list, with ADM-01's
 * section map on the left.
 *
 * The decisions are the sibling admin screens':
 * 1. **Authorization is the API's.** A caller without `org.manage` gets the ordinary 403, which
 *    `describe()` turns into a sentence in the page's own alert; the screen never guesses a
 *    capability of its own and never renders blank on a refusal.
 * 2. **No invented numbers.** Every figure is the API's; the frame's sample copy ("Karim Nabil
 *    leaves on 22 Aug") is replaced by sentences built from the live counts.
 * 3. **Recent changes are the audit log's.** The newest four events, read with `audit.read`; a
 *    refusal there is a quiet line, not a broken page.
 */
export function AdminOverviewScreen({
  organizationSlug,
  organizationName,
  client,
}: AdminOverviewScreenProps) {
  const api = client ?? browserApiClient();
  const t = useT();

  const overview = useQuery({
    queryKey: ['admin-overview', organizationSlug],
    queryFn: () => fetchAdminOverview(api, organizationSlug),
  });

  const recent = useQuery({
    queryKey: ['admin-overview', organizationSlug, 'recent-audit'],
    queryFn: () => listAuditEvents(api, organizationSlug, { limit: 4 }),
  });

  return (
    <ControlCenterShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      section="overview"
      crumbs={[t('AdminOverviewScreen.crumbOverview')]}
      title={t('AdminOverviewScreen.title')}
      actions={
        <Link
          href={`/${organizationSlug}/admin/audit`}
          className="tm-button tm-button--outline tm-button--compact"
        >
          {t('AdminOverviewScreen.everythingLogged')}
        </Link>
      }
      rail="sections"
    >
      <section aria-labelledby="tm-admin-overview-heading" className="tm-cc-column">
        <h2 id="tm-admin-overview-heading" className="tm-visually-hidden">
          {t('AdminOverviewScreen.orgHealthHeading')}
        </h2>

        {overview.isPending ? (
          <LoadingRegion
            label={t('AdminOverviewScreen.loadingOverview')}
            className="tm-stack tm-stack--tight"
          >
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {overview.isError ? (
          <InlineAlert tone="danger" title={t('AdminOverviewScreen.loadError')} live>
            {describe(overview.error)}
          </InlineAlert>
        ) : null}

        {overview.isSuccess ? (
          <OverviewMetrics organizationSlug={organizationSlug} overview={overview.data} />
        ) : null}
      </section>

      <section className="tm-cc-card" aria-labelledby="tm-admin-recent-heading">
        <div className="tm-cc-card__head">
          <h2 id="tm-admin-recent-heading" className="tm-cc-card__title">
            {t('AdminOverviewScreen.recentHeading')}
          </h2>
          <Link href={`/${organizationSlug}/admin/audit`}>
            {t('AdminOverviewScreen.openAuditLog')}
          </Link>
        </div>
        {recent.isPending ? (
          <LoadingRegion
            label={t('AdminOverviewScreen.loadingRecent')}
            className="tm-stack tm-stack--tight"
          >
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}
        {recent.isError ? <p className="tm-cc-note">{describe(recent.error)}</p> : null}
        {recent.isSuccess && recent.data.length === 0 ? (
          <p className="tm-cc-note">{t('AdminOverviewScreen.recentEmpty')}</p>
        ) : null}
        {recent.isSuccess && recent.data.length > 0 ? (
          <ul className="tm-cc-recent" aria-label={t('AdminOverviewScreen.recentListLabel')}>
            {recent.data.map((event) => (
              <li key={event.id}>
                <span className="tm-cc-recent__when">{formatWhen(event.occurredAt)}</span>
                <span>{event.summary}</span>
                <span className="tm-cc-recent__mark" aria-hidden="true" />
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </ControlCenterShell>
  );
}

/** The metric cards in the order they are shown, keyed to the fields the API returns. */
const METRICS: readonly {
  id: Exclude<keyof AdminOverviewView, 'computedAt'>;
  labelKey: MessageKey;
  sourceKey: MessageKey;
  kind: 'count' | 'bytes';
}[] = [
  {
    id: 'activeMembers',
    labelKey: 'AdminOverviewScreen.metricActiveMembers',
    sourceKey: 'AdminOverviewScreen.metricSourceMembers',
    kind: 'count',
  },
  {
    id: 'seatsUsed',
    labelKey: 'AdminOverviewScreen.metricSeatsUsed',
    sourceKey: 'AdminOverviewScreen.metricSourceBilling',
    kind: 'count',
  },
  {
    id: 'auditEventsWindow',
    labelKey: 'AdminOverviewScreen.metricAuditEventsWindow',
    sourceKey: 'AdminOverviewScreen.metricSourceAuditLog',
    kind: 'count',
  },
  {
    id: 'storageBytesUsed',
    labelKey: 'AdminOverviewScreen.metricStorageUsed',
    sourceKey: 'AdminOverviewScreen.metricSourceFiles',
    kind: 'bytes',
  },
];

function OverviewMetrics({
  organizationSlug,
  overview,
}: {
  organizationSlug: string;
  overview: AdminOverviewView;
}) {
  const t = useT();
  const leaving = overview.openOffboardings;
  return (
    <>
      <div className="tm-cc-card tm-cc-card--ink tm-cc-hero">
        <div className="tm-stack tm-stack--tight">
          <p className="tm-cc-eyebrow">
            <span className="tm-cc-orb" aria-hidden="true" />
            {leaving > 0 ? t('AdminOverviewScreen.actFirst') : t('AdminOverviewScreen.allClear')}
          </p>
          <p className="tm-cc-card__lead">
            {leaving > 0
              ? `${leaving} ${leaving === 1 ? t('AdminOverviewScreen.offboardingIs') : t('AdminOverviewScreen.offboardingsAre')} ${t('AdminOverviewScreen.leadInProgressRest')}`
              : t('AdminOverviewScreen.leadAllClear')}
          </p>
          <p className="tm-cc-card__body">
            {leaving > 0
              ? t('AdminOverviewScreen.bodyReview')
              : `${t('AdminOverviewScreen.computedPrefix')} ${formatMoment(overview.computedAt)} ${t('AdminOverviewScreen.computedSuffix')}`}
          </p>
        </div>
        {leaving > 0 ? (
          <div className="tm-cc-hero__actions">
            <Link
              href={`/${organizationSlug}/people/offboarding`}
              className="tm-button tm-button--lime"
            >
              {t('AdminOverviewScreen.reviewOffboardingImpact')}
            </Link>
          </div>
        ) : null}
      </div>

      <ul className="tm-cc-metrics" aria-label={t('AdminOverviewScreen.metricsListLabel')}>
        {METRICS.map(({ id, labelKey, sourceKey, kind }) => (
          <li className="tm-cc-metric" key={id}>
            <p className="tm-cc-metric__value">
              {kind === 'bytes' ? formatBytes(overview.storageBytesUsed) : overview[id]}
            </p>
            <p className="tm-cc-metric__label">
              {id === 'auditEventsWindow'
                ? `${t('AdminOverviewScreen.metricAuditEventsInPrefix')} ${overview.auditWindowDays} ${t('AdminOverviewScreen.metricDaysSuffix')}`
                : t(labelKey)}
            </p>
            <p className="tm-cc-metric__source">
              {t('AdminOverviewScreen.sourcePrefix')} {t(sourceKey)}
            </p>
          </li>
        ))}
      </ul>
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
 * Bytes as the person who owns the quota reads them — binary units, because storage is sold and
 * measured in powers of 1024. A whole multiple loses its decimal (`3 GiB`, not `3.0 GiB`); a partial
 * one keeps one place. Zero is `0 B`, never the largest unit at `0`. Mirrors `StorageUsageScreen`.
 */
const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'] as const;

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = Math.round(value * 10) / 10;
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  return `${text} ${UNITS[unit]}`;
}

/**
 * Format an ISO timestamp for display, following the browser's locale for the reason `SessionsScreen`
 * gives. An unparseable value is shown verbatim rather than as `Invalid Date`.
 */
function formatMoment(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(at);
}

/** "Today 09:40", "Yest 16:12", "13 Aug" — ADM-01's timestamp column. */
function formatWhen(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const time = at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (at.toDateString() === today.toDateString()) return `Today ${time}`;
  if (at.toDateString() === yesterday.toDateString()) return `Yest ${time}`;
  return at.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

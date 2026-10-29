'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { StatusDot } from '@tmanage/ui';
import { browserApiClient } from '../../../lib/api/browser-client';
import { fetchPlatformOrgOverview } from '../../../lib/api/platform-organizations';
import type { PlatformOrgOverviewView } from '../../../lib/api/platform-organizations';
import { useT } from '../../../lib/i18n/use-t';
import { PlatformPageState } from '../shared/PlatformPageState';
import { formatBytes, PlatformGate } from '../shared/platform-kit';
import type { ScreenProps } from '../shared/platform-kit';
import { stepUpRemainingSeconds } from '../shared/usePlatformPermissions';
import { useRelative } from './org-kit';

/** A1 `/platform` — the health of every organization at a glance (frame A1, SPEC §6). */
export function PlatformOrgOverviewScreen({ client }: ScreenProps) {
  const api = client ?? browserApiClient();
  const t = useT();
  const overview = useQuery({
    queryKey: ['platform', 'overview'],
    queryFn: () => fetchPlatformOrgOverview(api),
    retry: false,
  });
  return (
    <PlatformGate
      api={api}
      section="overview"
      crumbs={[t('PlatformOrgs.overviewCrumb')]}
      title={t('PlatformOrgs.overviewTitle')}
      description={t('PlatformOrgs.overviewSubtitle')}
      actions={() => (
        <div className="tm-cc-hero__actions">
          <Link className="tm-cc-row-button" href="/platform/support-sessions">
            {t('PlatformOrgs.openSupportSessions')} ({overview.data?.openSupportSessions ?? 0})
          </Link>
          <Link className="tm-cc-row-button" href="/platform/organizations?new=1">
            {t('PlatformOrgs.newOrganization')}
          </Link>
        </div>
      )}
    >
      {(me) => (
        <>
          <p className="tm-cc-eyebrow">
            {t('PlatformOrgs.eyebrowPlatformAdmin')} · {t('PlatformOrgs.stepUpValid')}{' '}
            {Math.ceil(stepUpRemainingSeconds(me) / 60)} {t('PlatformOrgs.minutesShort')}
          </p>
          {overview.isPending ? <PlatformPageState state="loading" /> : null}
          {overview.isError ? (
            <PlatformPageState
              state="error"
              error={overview.error}
              onRetry={() => void overview.refetch()}
            />
          ) : null}
          {overview.isSuccess ? <OverviewBody data={overview.data} /> : null}
        </>
      )}
    </PlatformGate>
  );
}

function OverviewBody({ data }: { data: PlatformOrgOverviewView }) {
  const t = useT();
  const relative = useRelative();
  const firstPurgeDays =
    data.firstPurgeAt === null
      ? null
      : Math.max(0, Math.ceil((new Date(data.firstPurgeAt).getTime() - Date.now()) / 86_400_000));
  const tiles: readonly {
    id: string;
    label: string;
    value: string;
    sub: string;
    attention?: boolean;
  }[] = [
    {
      id: 'orgs',
      label: t('PlatformOrgs.tileOrganizations'),
      value: String(data.companies),
      sub: `${data.companies - data.suspendedCompanies} ${t('PlatformOrgs.activeWord')} · ${data.suspendedCompanies} ${t('PlatformOrgs.suspendedWord')}`,
    },
    {
      id: 'deleted',
      label: t('PlatformOrgs.tileDeleted'),
      value: String(data.deletedInWindow),
      sub:
        firstPurgeDays === null
          ? t('PlatformOrgs.noPurgeScheduled')
          : t('PlatformOrgs.firstPurgeIn').replace('{days}', String(firstPurgeDays)),
    },
    {
      id: 'people',
      label: t('PlatformOrgs.tilePeople'),
      value: String(data.people),
      sub: `${data.activeToday} ${t('PlatformOrgs.activeToday')}`,
    },
    {
      id: 'signups',
      label: t('PlatformOrgs.tileSignups'),
      value: `${data.signups7d} / ${data.signups30d}`,
      sub: t('PlatformOrgs.signupsSub'),
    },
    {
      id: 'storage',
      label: t('PlatformOrgs.tileStorage'),
      value: formatBytes(data.storageBytesUsed),
      sub: t('PlatformOrgs.storageSub'),
    },
    {
      id: 'runs',
      label: t('PlatformOrgs.tileFailedRuns'),
      value: String(data.failedAutomationRuns7d),
      sub: t('PlatformOrgs.failedRunsSub'),
      attention: data.failedAutomationRuns7d > 0,
    },
    {
      id: 'outbox',
      label: t('PlatformOrgs.tileOutbox'),
      value: String(data.outboxErrors),
      sub: t('PlatformOrgs.outboxSub'),
      attention: data.outboxErrors > 0,
    },
    {
      id: 'support',
      label: t('PlatformOrgs.tileSupport'),
      value: String(data.openSupportSessions),
      sub: t('PlatformOrgs.supportSub'),
    },
  ];
  return (
    <div className="tm-cc-column">
      <ul className="tm-cc-metrics" aria-label={t('PlatformOrgs.overviewTitle')}>
        {tiles.map((tile) => (
          <li
            key={tile.id}
            className={tile.attention ? 'tm-cc-metric tm-cc-metric--attention' : 'tm-cc-metric'}
          >
            <p className="tm-cc-metric__label">{tile.label}</p>
            <p className="tm-cc-metric__value">{tile.value}</p>
            <p className="tm-cc-metric__source">{tile.sub}</p>
          </li>
        ))}
      </ul>
      <section className="tm-cc-card" aria-labelledby="tm-orgs-attention">
        <div className="tm-cc-card__head">
          <h2 id="tm-orgs-attention" className="tm-cc-card__title">
            {t('PlatformOrgs.needsAttention')}
          </h2>
        </div>
        {data.attention.length === 0 ? (
          <p className="tm-cc-note">{t('PlatformOrgs.nothingNeedsAttention')}</p>
        ) : (
          <ul className="tm-cc-rows">
            {data.attention.map((item) => (
              <li
                key={`${item.organizationId}-${item.kind}`}
                className="tm-cc-rows__grow tm-cc-hero__actions"
              >
                <StatusDot tone={item.level === 'action' ? 'danger' : 'warning'}>
                  {item.level === 'action'
                    ? t('PlatformOrgs.levelAction')
                    : t('PlatformOrgs.levelCheck')}
                </StatusDot>
                <span className="tm-cc-rows__title">{item.name}</span>
                <span className="tm-cc-cell-mono">{item.detail}</span>
                <Link
                  className="tm-cc-row-button"
                  href={`/platform/organizations/${item.organizationId}`}
                >
                  {t('PlatformOrgs.open')}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="tm-cc-card" aria-labelledby="tm-orgs-recent">
        <div className="tm-cc-card__head">
          <h2 id="tm-orgs-recent" className="tm-cc-card__title">
            {t('PlatformOrgs.recentActions')}
          </h2>
        </div>
        {data.recentActions.length === 0 ? (
          <p className="tm-cc-note">{t('PlatformOrgs.noRecentActions')}</p>
        ) : (
          <ul className="tm-cc-recent">
            {data.recentActions.map((action) => (
              <li key={action.id}>
                <span>
                  {action.actorEmail} · <span className="tm-cc-cell-mono">{action.action}</span>
                  {action.targetLabel ? ` · ${action.targetLabel}` : ''}
                </span>
                <span className="tm-cc-recent__when">{relative(action.occurredAt)}</span>
              </li>
            ))}
          </ul>
        )}
        <Link href="/platform/activity">{t('PlatformOrgs.openActionLog')}</Link>
      </section>
    </div>
  );
}

'use client';

import Link from 'next/link';
import { browserApiClient } from '../../../lib/api/browser-client';
import type { PlatformOrgDetailView } from '../../../lib/api/platform-organizations';
import { useT } from '../../../lib/i18n/use-t';
import type { ScreenProps } from '../shared/platform-kit';
import { formatGb, useRelative } from './org-kit';
import { OrgPage } from './OrgPage';

/** A3 `/platform/organizations/[id]` — one organization at a glance (frame A3). */
export function PlatformOrgDetailScreen({
  client,
  organizationId,
}: ScreenProps & { organizationId: string }) {
  const api = client ?? browserApiClient();
  const t = useT();
  return (
    <OrgPage
      api={api}
      organizationId={organizationId}
      tab="overview"
      title={t('PlatformOrgs.tabOverview')}
    >
      {(detail) => <DetailBody detail={detail} />}
    </OrgPage>
  );
}

function DetailBody({ detail }: { detail: PlatformOrgDetailView }) {
  const t = useT();
  const relative = useRelative();
  const org = detail.organization;
  const tiles: readonly {
    id: string;
    label: string;
    value: string;
    sub: string;
    attention?: boolean;
  }[] = [
    {
      id: 'people',
      label: t('PlatformOrgs.tilePeople'),
      value: String(org.people),
      sub: `${org.clients} ${t('PlatformOrgs.clientsWord')} · ${detail.counts.invited} ${t('PlatformOrgs.invitedWord')}`,
    },
    {
      id: 'projects',
      label: t('PlatformOrgs.tileProjects'),
      value: String(org.projects),
      sub: `${detail.counts.openApprovals} ${t('PlatformOrgs.openApprovalsWord')}`,
    },
    {
      id: 'storage',
      label: t('PlatformOrgs.tileStorage'),
      value: formatGb(org.storageBytes),
      sub: `${t('PlatformOrgs.of')} ${formatGb(org.storageLimitBytes)}`,
    },
    {
      id: 'runs',
      label: t('PlatformOrgs.tileFailedRuns'),
      value: String(org.failedRuns7d),
      sub: t('PlatformOrgs.failedRunsSub'),
      attention: org.failedRuns7d > 0,
    },
    {
      id: 'active',
      label: t('PlatformOrgs.colLastActive'),
      value: relative(org.lastActiveAt),
      sub:
        detail.integrations.length > 0
          ? detail.integrations.join(' · ')
          : t('PlatformOrgs.noIntegrations'),
    },
  ];
  return (
    <>
      <ul className="tm-cc-metrics" aria-label={t('PlatformOrgs.tabOverview')}>
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
      <div className="tm-cc-split tm-cc-split--even">
        <section className="tm-cc-card" aria-labelledby="tm-org-admins">
          <div className="tm-cc-card__head">
            <h2 id="tm-org-admins" className="tm-cc-card__title">
              {t('PlatformOrgs.ownersAdmins')}
            </h2>
            <Link href={`/platform/organizations/${org.id}/members`}>
              {t('PlatformOrgs.allMembers')}
            </Link>
          </div>
          {detail.admins.length === 0 ? (
            <p className="tm-cc-note">{t('PlatformOrgs.noAdmins')}</p>
          ) : (
            <ul className="tm-cc-rows">
              {detail.admins.map((admin) => (
                <li key={admin.membershipId} className="tm-cc-rows__grow">
                  <span className="tm-cc-rows__title">{admin.displayName}</span>
                  <span className="tm-cc-cell-mono">{admin.email}</span>
                  <span className="tm-chip">{admin.role}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="tm-cc-card" aria-labelledby="tm-org-support">
          <div className="tm-cc-card__head">
            <h2 id="tm-org-support" className="tm-cc-card__title">
              {t('PlatformOrgs.supportSessions')}
            </h2>
          </div>
          {detail.supportSessions.length === 0 ? (
            <p className="tm-cc-note">{t('PlatformOrgs.noSupportSessions')}</p>
          ) : (
            <ul className="tm-cc-recent">
              {detail.supportSessions.map((session) => (
                <li key={session.id}>
                  <span>
                    {session.adminName ?? session.adminEmail ?? '—'}
                    {session.reason ? ` · ${session.reason}` : ''} · {session.actionsCount}{' '}
                    {t('PlatformOrgs.actionsWord')}
                  </span>
                  <span className="tm-cc-recent__when">{relative(session.startedAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
      <section className="tm-cc-card" aria-labelledby="tm-org-audit">
        <div className="tm-cc-card__head">
          <h2 id="tm-org-audit" className="tm-cc-card__title">
            {t('PlatformOrgs.recentAudit')}
          </h2>
          <Link href={`/platform/activity?organizationId=${org.id}`}>
            {t('PlatformOrgs.openActionLog')}
          </Link>
        </div>
        {detail.audit.length === 0 && detail.platformActions.length === 0 ? (
          <p className="tm-cc-note">{t('PlatformOrgs.noRecentActions')}</p>
        ) : (
          <ul className="tm-cc-recent">
            {detail.platformActions.map((action) => (
              <li key={`p-${action.id}`}>
                <span>
                  {action.actorEmail} · <span className="tm-cc-cell-mono">{action.action}</span>
                  {action.reason ? ` · ${action.reason}` : ''}
                </span>
                <span className="tm-cc-recent__when">{relative(action.occurredAt)}</span>
              </li>
            ))}
            {detail.audit.map((event) => (
              <li key={`o-${event.id}`}>
                <span>
                  {event.actorEmail ?? '—'} ·{' '}
                  <span className="tm-cc-cell-mono">{event.action}</span>
                </span>
                <span className="tm-cc-recent__when">{relative(event.occurredAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

'use client';

import { useQuery } from '@tanstack/react-query';
import type { UseQueryResult } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { ControlCenterShell, ccKey } from '../admin/ControlCenterShell';
import type { ControlCenterKey } from '../admin/ControlCenterShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { fetchAdminOverview, invitationsWaiting, relativeWhen } from '../../lib/api/admin-overview';
import { fetchPendingInvitations } from '../../lib/api/admin-invitations';
import { listAuditEvents } from '../../lib/api/admin-audit';
import { getConnectedApps } from '../../lib/api/connected-apps';
import { listWorkflowTemplates } from '../../lib/api/automations';
import { readSecuritySettings } from '../../lib/api/admin-security';
import { useDescribeApiError } from '../../lib/api/describe-error';
import type { ApiClient } from '../../lib/api/client';
import { useOrganizationName } from '../../lib/use-organization-names';
import { useT } from '../../lib/i18n/use-t';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';

export interface AdminOverviewScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** Injected in tests. Defaults to the browser client. */
  client?: ApiClient;
  /** Test seam: a fixed clock for the activity times. */
  now?: Date;
}

/** `{count}` / `{org}` in a catalog string, filled from live data. */
function fill(text: string, values: Readonly<Record<string, string | number>>): string {
  return text.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in values ? String(values[name]) : match,
  );
}

/**
 * **Control Center — Overview** (OPS-1, Figma 370:1411 / 370:1699). Four cards — Members, Connected
 * apps, Automations, Security — and the three newest audit rows as plain sentences with a relative
 * time. Every figure is a read that already exists (admin overview, connected apps, workflow
 * templates, security settings, audit log); a card whose read is refused says so quietly instead
 * of breaking the page, and nothing is invented.
 */
export function AdminOverviewScreen({
  organizationSlug,
  organizationName,
  client,
  now,
}: AdminOverviewScreenProps) {
  const describe = useDescribeApiError();
  const api = client ?? browserApiClient();
  const t = useT();
  const cc = (key: ControlCenterKey | `ControlCenter.${string}`) => t(ccKey(key));
  const locale = useActiveLocale();
  const workspace = useOrganizationName(organizationSlug, organizationName);

  const overview = useQuery({
    queryKey: ['admin-overview', organizationSlug],
    queryFn: () => fetchAdminOverview(api, organizationSlug),
  });
  const apps = useQuery({
    queryKey: ['connected-apps', organizationSlug],
    queryFn: () => getConnectedApps(api, organizationSlug),
  });
  const automations = useQuery({
    queryKey: ['admin-overview', organizationSlug, 'automations'],
    queryFn: () => listWorkflowTemplates(api, organizationSlug),
  });
  const security = useQuery({
    queryKey: ['admin-security', organizationSlug],
    queryFn: () => readSecuritySettings(api, organizationSlug),
  });
  const recent = useQuery({
    queryKey: ['admin-overview', organizationSlug, 'recent-audit'],
    queryFn: () => listAuditEvents(api, organizationSlug, { limit: 3 }),
  });

  // The invitations live in their own table, not in the seat counters, so the counter formula said
  // "No invitations waiting" while People listed three (2026-10-31 live test). Count the pending,
  // unexpired invitations the People page counts; the counter formula is only the fallback.
  const pendingInvitations = useQuery({
    queryKey: ['admin-invitations', organizationSlug],
    queryFn: () => fetchPendingInvitations(api, organizationSlug),
    retry: false,
  });
  const waiting = Array.isArray(pendingInvitations.data?.invitations)
    ? pendingInvitations.data.invitations.filter((invitation) => !invitation.isExpired).length
    : overview.data
      ? invitationsWaiting(overview.data)
      : 0;
  const unverified = apps.data ? apps.data.apps.filter((app) => !app.verified).length : 0;
  const clock = now ?? new Date();

  return (
    <ControlCenterShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      section="overview"
      crumbs={[t('ControlCenterShell.overview')]}
      title={cc('ControlCenter.overviewTitle')}
      // Held back until the name has loaded: the sentence read "trust for  in one place" for a
      // moment on the live site (2026-10-31).
      {...(workspace.trim() === ''
        ? {}
        : { description: fill(cc('ControlCenter.overviewDescription'), { org: workspace }) })}
      rail="sections"
      {...(client ? { client } : {})}
    >
      {overview.isError ? (
        <InlineAlert tone="danger" title={t('AdminOverviewScreen.loadError')} live>
          {describe(overview.error)}
        </InlineAlert>
      ) : null}

      <ul className="tm-cc-ov-cards" aria-label={t('AdminOverviewScreen.metricsListLabel')}>
        <OverviewCard
          label={cc('ControlCenter.cardMembers')}
          query={overview}
          value={(data) => String(data.activeMembers)}
          note={() =>
            waiting === 0
              ? cc('ControlCenter.membersNoneWaiting')
              : waiting === 1
                ? cc('ControlCenter.membersWaitingOne')
                : fill(cc('ControlCenter.membersWaiting'), { count: waiting })
          }
          unavailable={cc('ControlCenter.cardUnavailable')}
          loading={t('AdminOverviewScreen.loadingOverview')}
        />
        <OverviewCard
          label={cc('ControlCenter.cardConnectedApps')}
          query={apps}
          value={(data) => String(data.apps.length)}
          note={() =>
            unverified === 0
              ? cc('ControlCenter.appsAllVerified')
              : unverified === 1
                ? cc('ControlCenter.appsUnverifiedOne')
                : fill(cc('ControlCenter.appsUnverified'), { count: unverified })
          }
          unavailable={cc('ControlCenter.cardUnavailable')}
          loading={t('AdminOverviewScreen.loadingOverview')}
        />
        <OverviewCard
          label={cc('ControlCenter.cardAutomations')}
          query={automations}
          value={(data) => String(data.filter((rule) => rule.enabled).length)}
          note={() => cc('ControlCenter.automationsRunning')}
          unavailable={cc('ControlCenter.cardUnavailable')}
          loading={t('AdminOverviewScreen.loadingOverview')}
        />
        <OverviewCard
          label={cc('ControlCenter.cardSecurity')}
          query={security}
          value={(data) =>
            data.enforce2fa ? cc('ControlCenter.securityOn') : cc('ControlCenter.securityOff')
          }
          note={(data) =>
            data.enforce2fa
              ? cc('ControlCenter.securityRequired')
              : cc('ControlCenter.securityOptional')
          }
          unavailable={cc('ControlCenter.cardUnavailable')}
          loading={t('AdminOverviewScreen.loadingOverview')}
        />
      </ul>

      <section className="tm-cc-ov-recent" aria-labelledby="tm-cc-ov-recent-heading">
        <h2 id="tm-cc-ov-recent-heading" className="tm-cc-ov-heading">
          {cc('ControlCenter.recentActivity')}
        </h2>
        {recent.isPending ? (
          <LoadingRegion label={t('AdminOverviewScreen.loadingRecent')}>
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}
        {recent.isError ? <p className="tm-cc-note">{describe(recent.error)}</p> : null}
        {recent.isSuccess && recent.data.length === 0 ? (
          <p className="tm-cc-note">{t('AdminOverviewScreen.recentEmpty')}</p>
        ) : null}
        {recent.isSuccess && recent.data.length > 0 ? (
          <ul className="tm-cc-ov-activity" aria-label={t('AdminOverviewScreen.recentListLabel')}>
            {recent.data.map((event) => (
              <li key={event.id}>
                <span className="tm-cc-ov-activity__what">{event.summary}</span>
                <time className="tm-cc-ov-activity__when" dateTime={event.occurredAt}>
                  {relativeWhen(event.occurredAt, clock, locale)}
                </time>
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </ControlCenterShell>
  );
}

function OverviewCard<Data>({
  label,
  query,
  value,
  note,
  unavailable,
  loading,
}: {
  label: string;
  query: UseQueryResult<Data>;
  value: (data: Data) => string;
  note: (data: Data) => string;
  unavailable: string;
  loading: string;
}) {
  return (
    <li className="tm-cc-ov-card">
      <p className="tm-cc-ov-card__label">{label}</p>
      {query.isPending ? (
        <LoadingRegion label={loading}>
          <Skeleton height="var(--t-heading-page-line)" />
        </LoadingRegion>
      ) : null}
      {query.isError ? (
        <>
          <p className="tm-cc-ov-card__value">—</p>
          <p className="tm-cc-ov-card__note">{unavailable}</p>
        </>
      ) : null}
      {query.isSuccess ? (
        <>
          <p className="tm-cc-ov-card__value">{value(query.data)}</p>
          <p className="tm-cc-ov-card__note">{note(query.data)}</p>
        </>
      ) : null}
    </li>
  );
}

'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { NavIcon } from '../icons/phone';
import { InviteClientDialog, IssuedLinkNotice, useClientsT } from '../clients/InviteClientDialog';
import { ArchiveCompanyDialog, RenameCompanyDialog } from '../clients/ClientCompanyDialogs';
import { ClientPeoplePanel, clientCompanyKey, isExpired } from '../clients/ClientPeoplePanel';
import { ClientProjectsPanel } from '../clients/ClientProjectsPanel';
import { OverviewBlocks } from '../overview/OverviewBlocks';
import { OverviewTabs } from '../overview/OverviewTabs';
import { clientOverviewModel } from '../overview/client-overview-model';
import { clientViewHref, clientsHref, type ClientView } from '../overview/overview-links';
import { useOverviewCopy } from '../overview/use-overview-copy';
import { useOverviewFormat } from '../overview/use-overview-format';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  getClientOrganization,
  listClientInvitations,
  listClientPeople,
  listClientProjects,
} from '../../lib/api/clients';
import { getClientSummary } from '../../lib/api/client-summary';
import type { IssuedInvitation } from '../../lib/api/invitations';
import type { ApiClient } from '../../lib/api/client';
import { describePeopleError } from './peopleShared';
import { clientStatus } from './ClientsScreen';
import { PreviewAsClientLink } from './PreviewAsClientLink';
import '../../styles/screens/clients.css';

export interface ClientCompanyScreenProps {
  organizationSlug: string;
  organizationName: string;
  clientOrganizationId: string;
  /** The tab from `?view=`; Overview when absent. */
  view?: ClientView;
  /** `?health=at-risk` on the Projects tab. */
  atRisk?: boolean;
  /** Injected in tests. Defaults to the browser client. */
  client?: ApiClient;
  /** Injected in tests so "sent 2 days ago" is stable. */
  now?: () => number;
}

const STATUS_KEY = {
  archived: 'Clients.statusArchived',
  invite_pending: 'Clients.statusInvitePending',
  portal_live: 'Clients.statusPortalLive',
  not_shared: 'Clients.statusNotShared',
} as const;

/**
 * **ONEPAGE — the client company page** (Figma 740:40765, AR 740:41300, phone 740:41828 /
 * 740:42254). Overview answers "how is this client doing" from one read (`GET …/client-
 * organizations/:id/summary`, B01): delivery across its projects, approvals waiting and on whom,
 * risks, latest files, time not invoiced and money, each block opening its full screen. The
 * Projects tab lists the projects shared with the company (with health), People its people and
 * invitations (with Resend, Rename and Archive). Behind `org.manage`, like before.
 */
export function ClientCompanyScreen({
  organizationSlug,
  organizationName,
  clientOrganizationId,
  view = 'overview',
  atRisk = false,
  client,
  now = Date.now,
}: ClientCompanyScreenProps) {
  const api = client ?? browserApiClient();
  const t = useClientsT();
  const copy = useOverviewCopy();
  const queryClient = useQueryClient();
  const [today] = useState(() => new Date(now()));
  const format = useOverviewFormat(today);
  const [dialog, setDialog] = useState<'invite' | 'rename' | 'archive' | null>(null);
  // 56-26 (B1): the stopped address "Check the address" opens the invite with.
  const [recheckEmail, setRecheckEmail] = useState('');
  const [issued, setIssued] = useState<IssuedInvitation | null>(null);

  const key = clientCompanyKey(organizationSlug, clientOrganizationId);
  const company = useQuery({
    queryKey: [...key, 'organization'],
    queryFn: () => getClientOrganization(api, organizationSlug, clientOrganizationId),
  });
  // The same keys the People tab reads, so the header's counts and the tab are one request each.
  const people = useQuery({
    queryKey: [...key, 'people'],
    queryFn: () => listClientPeople(api, organizationSlug, clientOrganizationId),
  });
  const invitations = useQuery({
    queryKey: [...key, 'invitations'],
    queryFn: () =>
      listClientInvitations(api, organizationSlug, clientOrganizationId, ['pending', 'expired']),
  });
  const projects = useQuery({
    queryKey: [...key, 'projects'],
    queryFn: () => listClientProjects(api, organizationSlug, clientOrganizationId),
  });
  const summary = useQuery({
    queryKey: [...key, 'summary'],
    queryFn: () => getClientSummary(api, organizationSlug, clientOrganizationId),
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['clients', organizationSlug] });

  const nowMs = today.getTime();
  const members = people.data ?? [];
  const shared = projects.data ?? [];
  const pending = (invitations.data ?? []).filter((item) => !isExpired(item, nowMs)).length;
  const org = company.data;
  const status = org ? clientStatus(org, pending, members) : null;
  const archived = org?.archivedAt != null;
  const bands = new Map((summary.data?.projects.items ?? []).map((item) => [item.id, item.band]));

  const peopleLabel = (count: number) =>
    count === 0
      ? t('Clients.peopleNone')
      : count === 1
        ? t('Clients.peopleOne')
        : t('Clients.peopleMany', { count });
  const projectsLabel = copy.count(
    'Overview.projectsOne',
    'Overview.projectsMany',
    shared.length,
    format.count(shared.length),
  );

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="clients"
      title={org?.name ?? t('Clients.title')}
      eyebrow={
        <Link className="tm-ov-back" href={clientsHref(organizationSlug)}>
          <NavIcon name="back" size={14} />
          {copy.text('Overview.backToClients')}
        </Link>
      }
      description={
        org && status
          ? [
              t('Clients.companyKind'),
              ...(projects.data ? [projectsLabel] : []),
              peopleLabel(members.length),
              t(STATUS_KEY[status]),
            ].join(' · ')
          : undefined
      }
      actions={
        org && !archived ? (
          <div className="tm-ov-actions">
            <PreviewAsClientLink organizationSlug={organizationSlug} compact={false} />
            <Button tone="ink" size="accessible" onClick={() => setDialog('invite')}>
              {t('Clients.invitePerson')}
            </Button>
          </div>
        ) : undefined
      }
    >
      <div className="tm-ov cl-screen cl-screen--company">
        {issued ? <IssuedLinkNotice issued={issued} onDone={() => setIssued(null)} /> : null}

        <OverviewTabs
          label={copy.text('Overview.tabsLabel')}
          current={view}
          tabs={[
            {
              id: 'overview',
              label: copy.text('Overview.tabOverview'),
              href: clientViewHref(organizationSlug, clientOrganizationId, 'overview'),
            },
            {
              id: 'projects',
              label: copy.text('Overview.tabProjects'),
              href: clientViewHref(organizationSlug, clientOrganizationId, 'projects'),
              ...(projects.data ? { count: format.count(shared.length) } : {}),
            },
            {
              id: 'people',
              label: copy.text('Overview.tabPeople'),
              href: clientViewHref(organizationSlug, clientOrganizationId, 'people'),
              ...(people.data ? { count: format.count(members.length) } : {}),
            },
          ]}
        />

        {company.isError ? (
          <InlineAlert tone="danger" title={t('Clients.companyNotFound')} live>
            {describePeopleError(company.error)}
          </InlineAlert>
        ) : company.isPending || !org ? (
          <LoadingRegion label={t('Clients.title')} className="tm-stack tm-stack--tight">
            <Skeleton height="56px" />
            <Skeleton height="56px" />
          </LoadingRegion>
        ) : view === 'overview' ? (
          summary.isPending ? (
            <OverviewBlocks state="loading" />
          ) : summary.isError ? (
            <OverviewBlocks state="error" onRetry={() => void summary.refetch()} />
          ) : (
            <OverviewBlocks
              state="ready"
              now={today}
              deliveryEmpty="projects"
              model={clientOverviewModel(summary.data, organizationSlug, today)}
            />
          )
        ) : view === 'projects' ? (
          <ClientProjectsPanel
            organizationSlug={organizationSlug}
            clientOrganizationId={clientOrganizationId}
            projects={shared}
            pending={projects.isPending}
            error={projects.error}
            bands={bands}
            atRisk={atRisk}
          />
        ) : (
          <>
            {archived ? null : (
              <div className="tm-ov-actions">
                <Button tone="outline" size="accessible" onClick={() => setDialog('rename')}>
                  {t('Clients.rename')}
                </Button>
                <Button tone="outline" size="accessible" onClick={() => setDialog('archive')}>
                  {t('Clients.archiveClient')}
                </Button>
              </div>
            )}
            <ClientPeoplePanel
              api={api}
              organizationSlug={organizationSlug}
              organization={org}
              now={nowMs}
              onIssued={setIssued}
              onCheckAddress={(email) => {
                setRecheckEmail(email);
                setDialog('invite');
              }}
            />
          </>
        )}
      </div>

      {dialog === 'invite' && org ? (
        <InviteClientDialog
          api={api}
          organizationSlug={organizationSlug}
          organizations={[org]}
          initialCompanyName={org.name}
          initialEmail={recheckEmail}
          onClose={() => {
            setDialog(null);
            setRecheckEmail('');
          }}
          onIssued={async (result) => {
            if (result.delivery !== 'sent') setIssued(result);
            await refresh();
            setDialog(null);
            setRecheckEmail('');
          }}
        />
      ) : null}

      {dialog === 'rename' && org ? (
        <RenameCompanyDialog
          api={api}
          organizationSlug={organizationSlug}
          organization={org}
          onClose={() => setDialog(null)}
          onDone={async () => {
            await refresh();
            setDialog(null);
          }}
        />
      ) : null}

      {dialog === 'archive' && org ? (
        <ArchiveCompanyDialog
          api={api}
          organizationSlug={organizationSlug}
          organization={org}
          onClose={() => setDialog(null)}
          onDone={async () => {
            await refresh();
            setDialog(null);
          }}
        />
      ) : null}
    </AppShell>
  );
}

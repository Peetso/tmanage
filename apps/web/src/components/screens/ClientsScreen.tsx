'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, SearchField, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { useShellCapability } from '../shell/use-shell-capability';
import { TeachingEmptyState } from '../help/TeachingEmptyState';
import { ViewSwitcher } from '../views/ViewSwitcher';
import { useViewPreference } from '../views/use-view-preference';
import {
  InviteClientDialog,
  IssuedLinkNotice,
  useClientsT,
  type ClientsKey,
} from '../clients/InviteClientDialog';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  listClientInvitations,
  listClientMemberships,
  listClientOrganizations,
  reissueClientInvitation,
} from '../../lib/api/clients';
import type { ClientMembership, ClientOrganization } from '../../lib/api/clients';
import type { InvitationSummary, IssuedInvitation } from '../../lib/api/invitations';
import type { ApiClient } from '../../lib/api/client';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import { useTOr } from '../../lib/i18n/use-t-or';
import { describePeopleError, initialsOf } from './peopleShared';
import { NotDeliveredChip, StoppedInvitationNotice } from '../people/StoppedInvitationNotice';
import '../../styles/screens/clients.css';

export type ClientStatus = 'archived' | 'invite_pending' | 'portal_live' | 'not_shared';

/**
 * The status pill, in the design's order of precedence: an archived company is Archived whatever
 * else is true; an open invitation reads Invite pending; otherwise one active person means the
 * portal is live, and none means nothing has been shared yet.
 */
export function clientStatus(
  organization: ClientOrganization,
  pendingInvitations: number,
  memberships: readonly ClientMembership[],
): ClientStatus {
  if (organization.archivedAt !== null) return 'archived';
  if (pendingInvitations > 0) return 'invite_pending';
  if (memberships.some((membership) => membership.status === 'active')) return 'portal_live';
  return 'not_shared';
}

const STATUS_KEY: Readonly<Record<ClientStatus, ClientsKey>> = {
  archived: 'Clients.statusArchived',
  invite_pending: 'Clients.statusInvitePending',
  portal_live: 'Clients.statusPortalLive',
  not_shared: 'Clients.statusNotShared',
};

const STATUS_GLYPH: Readonly<Record<ClientStatus, string>> = {
  archived: '▨',
  invite_pending: '◷',
  portal_live: '◎',
  not_shared: '○',
};

export const ROLE_KEY: Readonly<Record<string, ClientsKey>> = {
  client_reviewer: 'Clients.roleReviewer',
  client_admin: 'Clients.roleAdmin',
  client_viewer: 'Clients.roleViewer',
};

function isExpired(invitation: InvitationSummary, now: number): boolean {
  return invitation.status === 'expired' || Date.parse(invitation.expiresAt) <= now;
}

function daysSince(iso: string, now: number): number {
  const start = new Date(iso);
  const today = new Date(now);
  const startDay = Date.UTC(start.getFullYear(), start.getMonth(), start.getDate());
  const todayDay = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.max(0, Math.round((todayDay - startDay) / 86_400_000));
}

/** R38 G5-views: the client companies as rows or as cards. */
const CLIENTS_LAYOUTS = ['list', 'grid'] as const;
type ClientsLayout = (typeof CLIENTS_LAYOUTS)[number];

export interface ClientsScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** Injected in tests. Defaults to the browser client. */
  client?: ApiClient;
  /** Injected in tests so "sent 2 days ago" is stable. */
  now?: () => number;
}

interface InvitationRow {
  readonly invitation: InvitationSummary;
  readonly organizationName: string;
  readonly expired: boolean;
}

/**
 * **Clients** (Q1, Figma t5-a 370:3711 EN / 370:4032 AR) — the client companies this organization
 * works with and the people invited from them.
 *
 * Two cards: "Client organizations" (initials orb, name, people count, status pill) and
 * "Pending invitations" across every company (email, company, when it was sent, role pill and
 * Resend / Send again), with the purple note that clients only see what is shared with them. The
 * tabs carry the two counts; the search narrows both lists in the browser. "Invite client" opens
 * {@link InviteClientDialog} (t5-b).
 *
 * 2026-10-31 live-test fixes (Figma "Clients · Invitations tab, invite re-sent" 446:37206): the
 * Invitations tab shows the invitations card alone; Resend confirms with a success line and the
 * row's button reads "Sent ✓"; each company row opens its own page (`/clients/:id`, Figma
 * "Clients · Client company detail" 446:37327); the list is refreshed before the dialog closes.
 */
export function ClientsScreen({
  organizationSlug,
  organizationName,
  client,
  now = Date.now,
}: ClientsScreenProps) {
  const api = client ?? browserApiClient();
  const t = useClientsT();
  const tOr = useTOr();
  const canUse = useShellCapability(organizationSlug, client);
  const locale = useActiveLocale();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [view, setView] = useState<'organizations' | 'invitations'>('organizations');
  const [layout, setLayout] = useViewPreference<ClientsLayout>(
    `clients:${organizationSlug}`,
    CLIENTS_LAYOUTS,
    'list',
  );
  const [inviting, setInviting] = useState(false);
  // 56-26 (B1): "Check the address" on a stopped invitation reopens the invite with it filled in.
  const [recheck, setRecheck] = useState<{ email: string; companyName: string } | null>(null);
  const [issued, setIssued] = useState<IssuedInvitation | null>(null);
  // The email of the invitation just re-sent. A resend revokes the old row and issues a new one,
  // so the confirmation follows the address, not the row id.
  const [resentEmail, setResentEmail] = useState<string | null>(null);

  const organizations = useQuery({
    queryKey: ['clients', organizationSlug, 'organizations'],
    queryFn: () => listClientOrganizations(api, organizationSlug),
  });
  const companies = useMemo(
    () => (Array.isArray(organizations.data) ? organizations.data : []),
    [organizations.data],
  );

  const invitationQueries = useQueries({
    queries: companies.map((company) => ({
      queryKey: ['clients', organizationSlug, 'invitations', company.id],
      queryFn: () =>
        listClientInvitations(api, organizationSlug, company.id, ['pending', 'expired']),
    })),
  });
  const membershipQueries = useQueries({
    queries: companies.map((company) => ({
      queryKey: ['clients', organizationSlug, 'memberships', company.id],
      queryFn: () => listClientMemberships(api, organizationSlug, company.id),
    })),
  });

  const nowMs = now();
  const rows = companies.map((company, index) => {
    const invitations = invitationQueries[index]?.data ?? [];
    const memberships = membershipQueries[index]?.data ?? [];
    const pending = invitations.filter((invitation) => !isExpired(invitation, nowMs)).length;
    return {
      company,
      memberships,
      invitations,
      status: clientStatus(company, pending, memberships),
    };
  });

  const invitationRows: InvitationRow[] = rows
    .flatMap((row) =>
      row.invitations.map((invitation) => ({
        invitation,
        organizationName: row.company.name,
        expired: isExpired(invitation, nowMs),
      })),
    )
    .sort((a, b) => b.invitation.createdAt.localeCompare(a.invitation.createdAt));

  // B3 (live test 2026-11-02): a tab count is drawn only once its list has loaded. Before, a
  // pending, failed or signed-out read drew "Organizations 0" beside companies that do exist.
  const invitationsLoaded =
    organizations.isSuccess && invitationQueries.every((query) => query.isSuccess);

  const term = search.trim().toLocaleLowerCase();
  const shownRows =
    term === '' ? rows : rows.filter((row) => row.company.name.toLocaleLowerCase().includes(term));
  const shownInvitations =
    term === ''
      ? invitationRows
      : invitationRows.filter(
          (row) =>
            row.invitation.email.toLocaleLowerCase().includes(term) ||
            row.organizationName.toLocaleLowerCase().includes(term),
        );

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['clients', organizationSlug] });

  const resend = useMutation({
    mutationFn: (invitation: InvitationSummary) =>
      reissueClientInvitation(api, organizationSlug, invitation.id),
    onMutate: () => setResentEmail(null),
    onSuccess: (result, invitation) => {
      if (result.delivery !== 'sent') setIssued(result);
      else setResentEmail(invitation.email);
      void refresh();
    },
  });

  const peopleLabel = (count: number) =>
    count === 0
      ? t('Clients.peopleNone')
      : count === 1
        ? t('Clients.peopleOne')
        : t('Clients.peopleMany', { count });

  const sentLabel = (row: InvitationRow) => {
    if (row.expired) return t('Clients.expired');
    if (resentEmail !== null && row.invitation.email === resentEmail) {
      return t('Clients.sentAgainJustNow');
    }
    const days = daysSince(row.invitation.createdAt, nowMs);
    if (days === 0) return t('Clients.sentToday');
    if (days === 1) return t('Clients.sentYesterday');
    return t('Clients.sentDaysAgo', { count: days });
  };

  const archivedLabel = (iso: string) =>
    t('Clients.archivedOn', {
      date: new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' }).format(
        new Date(iso),
      ),
    });

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="clients"
      title={t('Clients.title')}
      description={t('Clients.subtitle')}
      actions={
        <div className="cl-header-actions">
          <form noValidate role="search" onSubmit={(event) => event.preventDefault()}>
            <SearchField
              className="cl-search"
              label={t('Clients.searchLabel')}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t('Clients.searchPlaceholder')}
            />
          </form>
          <Link
            className="tm-button tm-button--outline tm-button--accessible"
            href={`/${organizationSlug}/clients/import`}
          >
            {tOr('ContactsImport.title', 'Import contacts')}
          </Link>
          <Button tone="ink" size="accessible" onClick={() => setInviting(true)}>
            {t('Clients.inviteClient')}
          </Button>
        </div>
      }
    >
      <div className="cl-screen" data-view={view} data-layout={layout}>
        <div className="cl-tabs" role="group" aria-label={t('Clients.viewsLabel')}>
          <button
            type="button"
            className="cl-tab"
            aria-pressed={view === 'organizations'}
            onClick={() => setView('organizations')}
          >
            {t('Clients.tabOrganizations')}
            {organizations.isSuccess ? <span className="cl-count">{companies.length}</span> : null}
          </button>
          <button
            type="button"
            className="cl-tab"
            aria-pressed={view === 'invitations'}
            onClick={() => setView('invitations')}
          >
            {t('Clients.tabInvitations')}
            {invitationsLoaded ? <span className="cl-count">{invitationRows.length}</span> : null}
          </button>
          {view === 'organizations' ? (
            <ViewSwitcher
              className="cl-view-switcher"
              label={tOr('ViewSwitcher.clientsLabel', 'Clients view')}
              options={[
                { id: 'list', label: tOr('ViewSwitcher.list', 'List') },
                { id: 'grid', label: tOr('ViewSwitcher.grid', 'Grid') },
              ]}
              value={layout}
              onChange={setLayout}
            />
          ) : null}
        </div>

        {issued ? <IssuedLinkNotice issued={issued} onDone={() => setIssued(null)} /> : null}
        {resentEmail !== null ? (
          <InlineAlert tone="success" title={t('Clients.resentTitle')} live>
            {t('Clients.resentBody', { email: resentEmail })}
          </InlineAlert>
        ) : null}
        {resend.isError ? (
          <InlineAlert tone="danger" title={t('Clients.resendFailed')} live>
            {describePeopleError(resend.error)}
          </InlineAlert>
        ) : null}

        {organizations.isError ? (
          <InlineAlert tone="danger" title={t('Clients.loadFailed')} live>
            {describePeopleError(organizations.error)}
          </InlineAlert>
        ) : organizations.isSuccess && companies.length === 0 ? (
          // 55-10p: no company means no invitation either (each belongs to a company), so a truly
          // empty Clients page teaches in place of the two cards.
          <TeachingEmptyState
            title={tOr('EmptyStates.clientsTitle', 'No clients yet')}
            explanation={t('Clients.emptyOrganizations')}
            action={
              canUse('org.manage') ? (
                <Button tone="lime" size="accessible" onClick={() => setInviting(true)}>
                  {t('Clients.inviteClient')}
                </Button>
              ) : undefined
            }
            helpSlug="invite-a-client"
            helpLabel={tOr('EmptyStates.howClientInvitesWork', 'How client invites work')}
          />
        ) : (
          <div className="cl-grid">
            <section
              className="tm-card cl-card cl-card--organizations"
              aria-labelledby="cl-organizations-title"
            >
              <h2 id="cl-organizations-title" className="cl-card__title">
                {t('Clients.organizationsTitle')}
              </h2>
              {organizations.isPending ? (
                <LoadingRegion
                  label={t('Clients.organizationsTitle')}
                  className="tm-stack tm-stack--tight"
                >
                  <Skeleton height="56px" />
                  <Skeleton height="56px" />
                  <Skeleton height="56px" />
                </LoadingRegion>
              ) : shownRows.length === 0 ? (
                <p className="cl-empty">{t('Clients.noMatches')}</p>
              ) : (
                <ul
                  className={layout === 'grid' ? 'cl-list tm-view-grid' : 'cl-list'}
                  aria-label={t('Clients.organizationsTitle')}
                >
                  {shownRows.map((row) => (
                    <li key={row.company.id} className="cl-item">
                      <Link
                        className={
                          layout === 'grid'
                            ? 'cl-row cl-row--link cl-row--card tm-view-card'
                            : 'cl-row cl-row--link'
                        }
                        href={`/${organizationSlug}/clients/${encodeURIComponent(row.company.id)}`}
                      >
                        <span className="cl-orb" aria-hidden="true">
                          {initialsOf(row.company.name)}
                        </span>
                        <span className="cl-row__text">
                          <span className="cl-row__name">{row.company.name}</span>
                          <span className="cl-row__meta">
                            {row.company.archivedAt !== null
                              ? archivedLabel(row.company.archivedAt)
                              : peopleLabel(row.memberships.length)}
                          </span>
                        </span>
                        <span className={`cl-status cl-status--${row.status}`}>
                          <span aria-hidden="true">{STATUS_GLYPH[row.status]}</span>
                          {t(STATUS_KEY[row.status])}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section
              className="tm-card cl-card cl-card--invitations"
              aria-labelledby="cl-invitations-title"
            >
              <h2 id="cl-invitations-title" className="cl-card__title">
                {t('Clients.invitationsTitle')}
                <span className="cl-count cl-count--client">{invitationRows.length}</span>
              </h2>
              {shownInvitations.length === 0 ? (
                <p className="cl-empty">
                  {term === '' ? t('Clients.emptyInvitations') : t('Clients.noMatches')}
                </p>
              ) : (
                <ul className="cl-list" aria-label={t('Clients.invitationsTitle')}>
                  {shownInvitations.map((row) => {
                    const justResent = resentEmail !== null && row.invitation.email === resentEmail;
                    return (
                      <li
                        key={row.invitation.id}
                        className={
                          row.invitation.deliveryStopped ? 'cl-row cl-row--stopped' : 'cl-row'
                        }
                      >
                        <span className="cl-orb" aria-hidden="true">
                          {row.invitation.email.slice(0, 2).toUpperCase()}
                        </span>
                        <span className="cl-row__text">
                          <span className="cl-row__name cl-break">
                            {row.invitation.email}{' '}
                            {row.invitation.deliveryStopped ? <NotDeliveredChip /> : null}
                          </span>
                          <span className="cl-row__meta">
                            {row.organizationName} · {sentLabel(row)}
                          </span>
                        </span>
                        <span className="cl-role">
                          {ROLE_KEY[row.invitation.role]
                            ? t(ROLE_KEY[row.invitation.role]!)
                            : row.invitation.role}
                        </span>
                        <Button
                          tone="text"
                          size="compact"
                          className="cl-resend"
                          disabled={resend.isPending || justResent}
                          onClick={() => resend.mutate(row.invitation)}
                        >
                          {justResent
                            ? t('Clients.resentButton')
                            : row.expired
                              ? t('Clients.sendAgain')
                              : t('Clients.resend')}
                        </Button>
                        {row.invitation.deliveryStopped ? (
                          <StoppedInvitationNotice
                            api={api}
                            organizationSlug={organizationSlug}
                            email={row.invitation.email}
                            busy={resend.isPending}
                            onCheckAddress={() =>
                              setRecheck({
                                email: row.invitation.email,
                                companyName: row.organizationName,
                              })
                            }
                            onResend={() => resend.mutate(row.invitation)}
                          />
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              )}
              <p className="cl-note">
                <span aria-hidden="true">◎</span>
                {t('Clients.infoNote')}
              </p>
            </section>
          </div>
        )}
      </div>

      {inviting || recheck !== null ? (
        <InviteClientDialog
          api={api}
          organizationSlug={organizationSlug}
          organizations={companies.filter((company) => company.archivedAt === null)}
          initialEmail={recheck?.email ?? ''}
          initialCompanyName={recheck?.companyName ?? ''}
          onClose={() => {
            setInviting(false);
            setRecheck(null);
          }}
          onIssued={async (result) => {
            if (result.delivery !== 'sent') setIssued(result);
            // Refresh first, so the list already shows the new company when the dialog closes.
            await refresh();
            setInviting(false);
            setRecheck(null);
          }}
        />
      ) : null}
    </AppShell>
  );
}

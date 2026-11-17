'use client';

import { useEffect, useId, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { InviteClientDialog, IssuedLinkNotice, useClientsT } from '../clients/InviteClientDialog';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  archiveClientOrganization,
  getClientOrganization,
  listClientInvitations,
  listClientPeople,
  listClientProjects,
  reissueClientInvitation,
  renameClientOrganization,
} from '../../lib/api/clients';
import type { ClientOrganization } from '../../lib/api/clients';
import type { InvitationSummary, IssuedInvitation } from '../../lib/api/invitations';
import type { ApiClient } from '../../lib/api/client';
import { describePeopleError, initialsOf } from './peopleShared';
import { NotDeliveredChip, StoppedInvitationNotice } from '../people/StoppedInvitationNotice';
import { ROLE_KEY, clientStatus } from './ClientsScreen';
import { PreviewAsClientLink } from './PreviewAsClientLink';
import '../../styles/screens/clients.css';

export interface ClientCompanyScreenProps {
  organizationSlug: string;
  organizationName: string;
  clientOrganizationId: string;
  /** Injected in tests. Defaults to the browser client. */
  client?: ApiClient;
  /** Injected in tests so "sent 2 days ago" is stable. */
  now?: () => number;
}

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

const STATUS_KEY = {
  archived: 'Clients.statusArchived',
  invite_pending: 'Clients.statusInvitePending',
  portal_live: 'Clients.statusPortalLive',
  not_shared: 'Clients.statusNotShared',
} as const;

/**
 * **Client company** — one client organization's own page (2026-10-31 live-test fix; Figma
 * "Clients · Client company detail (2026-10-31 live-test fix)" 446:37327, with the rename dialog
 * 446:37470 and the archive confirmation 446:37514).
 *
 * Opened from a row on Clients. The company's name, its people (name, email, role), the projects
 * shared with it (B10, each opening the project), its pending invitations with Resend, and three
 * actions: Rename (`PATCH client-organizations/:id`), Archive
 * (`DELETE`, which archives) and Invite person (the t5-b dialog with this company filled in).
 */
export function ClientCompanyScreen({
  organizationSlug,
  organizationName,
  clientOrganizationId,
  client,
  now = Date.now,
}: ClientCompanyScreenProps) {
  const api = client ?? browserApiClient();
  const t = useClientsT();
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<'invite' | 'rename' | 'archive' | null>(null);
  // 56-26 (B1): the stopped address "Check the address" opens the invite with.
  const [recheckEmail, setRecheckEmail] = useState('');
  const [issued, setIssued] = useState<IssuedInvitation | null>(null);
  const [resentEmail, setResentEmail] = useState<string | null>(null);

  const key = ['clients', organizationSlug, 'company', clientOrganizationId] as const;
  const company = useQuery({
    queryKey: [...key, 'organization'],
    queryFn: () => getClientOrganization(api, organizationSlug, clientOrganizationId),
  });
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

  const nowMs = now();
  const members = people.data ?? [];
  const shared = projects.data ?? [];
  const invites = [...(invitations.data ?? [])].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );
  const pending = invites.filter((invitation) => !isExpired(invitation, nowMs)).length;
  const org = company.data;
  const status = org ? clientStatus(org, pending, members) : null;

  const peopleLabel = (count: number) =>
    count === 0
      ? t('Clients.peopleNone')
      : count === 1
        ? t('Clients.peopleOne')
        : t('Clients.peopleMany', { count });

  const sentLabel = (invitation: InvitationSummary) => {
    if (isExpired(invitation, nowMs)) return t('Clients.expired');
    if (invitation.email === resentEmail) return t('Clients.sentAgainJustNow');
    const days = daysSince(invitation.createdAt, nowMs);
    if (days === 0) return t('Clients.sentToday');
    if (days === 1) return t('Clients.sentYesterday');
    return t('Clients.sentDaysAgo', { count: days });
  };

  const roleLabel = (role: string) => (ROLE_KEY[role] ? t(ROLE_KEY[role]!) : role);
  const archived = org?.archivedAt != null;

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="clients"
      title={org?.name ?? t('Clients.title')}
      eyebrow={
        <Link className="cl-back" href={`/${organizationSlug}/clients`}>
          {t('Clients.backToClients')}
        </Link>
      }
      description={
        org && status
          ? `${t('Clients.companyKind')} · ${peopleLabel(members.length)} · ${t(STATUS_KEY[status])}`
          : undefined
      }
      actions={
        org && !archived ? (
          <div className="cl-header-actions">
            <PreviewAsClientLink organizationSlug={organizationSlug} compact={false} />
            <Button tone="outline" size="accessible" onClick={() => setDialog('rename')}>
              {t('Clients.rename')}
            </Button>
            <Button tone="outline" size="accessible" onClick={() => setDialog('archive')}>
              {t('Clients.archiveClient')}
            </Button>
            <Button tone="ink" size="accessible" onClick={() => setDialog('invite')}>
              {t('Clients.invitePerson')}
            </Button>
          </div>
        ) : undefined
      }
    >
      <div className="cl-screen cl-screen--company">
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

        {company.isError ? (
          <InlineAlert tone="danger" title={t('Clients.companyNotFound')} live>
            {describePeopleError(company.error)}
          </InlineAlert>
        ) : company.isPending ? (
          <LoadingRegion label={t('Clients.title')} className="tm-stack tm-stack--tight">
            <Skeleton height="56px" />
            <Skeleton height="56px" />
          </LoadingRegion>
        ) : (
          <div className="cl-grid">
            <section
              className="tm-card cl-card cl-card--organizations"
              aria-labelledby="cl-people-title"
            >
              <h2 id="cl-people-title" className="cl-card__title">
                {t('Clients.peopleTitle')}
              </h2>
              {people.isError ? (
                <InlineAlert tone="danger" title={t('Clients.loadFailed')} live>
                  {describePeopleError(people.error)}
                </InlineAlert>
              ) : members.length === 0 ? (
                <p className="cl-empty">{people.isPending ? '' : t('Clients.companyNoPeople')}</p>
              ) : (
                <ul className="cl-list" aria-label={t('Clients.peopleTitle')}>
                  {members.map((member) => {
                    const name = member.displayName ?? member.email ?? roleLabel(member.role);
                    return (
                      <li key={member.id} className="cl-row">
                        <span className="cl-orb" aria-hidden="true">
                          {initialsOf(name)}
                        </span>
                        <span className="cl-row__text">
                          <span className="cl-row__name">{name}</span>
                          <span className="cl-row__meta cl-break">
                            {member.email ? `${member.email} · ` : ''}
                            {roleLabel(member.role)}
                          </span>
                        </span>
                        <span className="cl-status cl-status--portal_live">
                          <span aria-hidden="true">◎</span>
                          {t('Clients.memberActive')}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>

            <section
              className="tm-card cl-card cl-card--invitations"
              aria-labelledby="cl-company-invitations-title"
            >
              <h2 id="cl-company-invitations-title" className="cl-card__title">
                {t('Clients.invitationsTitle')}
                <span className="cl-count cl-count--client">{invites.length}</span>
              </h2>
              {invites.length === 0 ? (
                <p className="cl-empty">{t('Clients.emptyInvitations')}</p>
              ) : (
                <ul className="cl-list" aria-label={t('Clients.invitationsTitle')}>
                  {invites.map((invitation) => {
                    const expired = isExpired(invitation, nowMs);
                    const justResent = invitation.email === resentEmail;
                    return (
                      <li
                        key={invitation.id}
                        className={invitation.deliveryStopped ? 'cl-row cl-row--stopped' : 'cl-row'}
                      >
                        <span className="cl-orb" aria-hidden="true">
                          {invitation.email.slice(0, 2).toUpperCase()}
                        </span>
                        <span className="cl-row__text">
                          <span className="cl-row__name cl-break">
                            {invitation.email}{' '}
                            {invitation.deliveryStopped ? <NotDeliveredChip /> : null}
                          </span>
                          <span className="cl-row__meta">{sentLabel(invitation)}</span>
                        </span>
                        <span className="cl-role">{roleLabel(invitation.role)}</span>
                        {archived ? null : (
                          <Button
                            tone="text"
                            size="compact"
                            className="cl-resend"
                            disabled={resend.isPending || justResent}
                            onClick={() => resend.mutate(invitation)}
                          >
                            {justResent
                              ? t('Clients.resentButton')
                              : expired
                                ? t('Clients.sendAgain')
                                : t('Clients.resend')}
                          </Button>
                        )}
                        {invitation.deliveryStopped && !archived ? (
                          <StoppedInvitationNotice
                            api={api}
                            organizationSlug={organizationSlug}
                            email={invitation.email}
                            busy={resend.isPending}
                            onCheckAddress={() => {
                              setRecheckEmail(invitation.email);
                              setDialog('invite');
                            }}
                            onResend={() => resend.mutate(invitation)}
                          />
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              )}
              {org ? (
                <p className="cl-note">
                  <span aria-hidden="true">◎</span>
                  {t('Clients.companyNote', { name: org.name })}
                </p>
              ) : null}
            </section>

            <section
              className="tm-card cl-card cl-card--organizations cl-card--projects"
              aria-labelledby="cl-company-projects-title"
            >
              <h2 id="cl-company-projects-title" className="cl-card__title">
                {t('Clients.sharedProjectsTitle')}
                <span className="cl-count cl-count--client">{shared.length}</span>
              </h2>
              {projects.isError ? (
                <InlineAlert tone="danger" title={t('Clients.loadFailed')} live>
                  {describePeopleError(projects.error)}
                </InlineAlert>
              ) : shared.length === 0 ? (
                <p className="cl-empty">
                  {projects.isPending ? '' : t('Clients.sharedProjectsNone')}
                </p>
              ) : (
                <ul className="cl-list" aria-label={t('Clients.sharedProjectsTitle')}>
                  {shared.map((project) => (
                    <li key={project.id} className="cl-item">
                      <Link
                        className="cl-row cl-row--link"
                        href={`/${organizationSlug}/projects/${encodeURIComponent(project.id)}`}
                      >
                        <span className="cl-orb" aria-hidden="true">
                          {initialsOf(project.name)}
                        </span>
                        <span className="cl-row__text">
                          <span className="cl-row__name cl-break">{project.name}</span>
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
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

function useEscape(onClose: () => void) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
}

interface CompanyDialogProps {
  api: ApiClient;
  organizationSlug: string;
  organization: ClientOrganization;
  onClose: () => void;
  onDone: () => Promise<unknown>;
}

/** Figma "Clients · Rename client company (2026-10-31 live-test fix)" 446:37470. */
function RenameCompanyDialog({
  api,
  organizationSlug,
  organization,
  onClose,
  onDone,
}: CompanyDialogProps) {
  const t = useClientsT();
  const titleId = useId();
  const [name, setName] = useState(organization.name);
  useEscape(onClose);

  const save = useMutation({
    mutationFn: () => renameClientOrganization(api, organizationSlug, organization, name.trim()),
    onSuccess: () => onDone(),
  });
  const canSave = name.trim() !== '' && name.trim() !== organization.name && !save.isPending;

  return (
    <div className="tm-command-palette__backdrop cl-backdrop">
      <div role="dialog" aria-modal="true" aria-labelledby={titleId} className="cl-dialog">
        <h2 id={titleId} className="cl-dialog__title">
          {t('Clients.renameTitle')}
        </h2>
        <p className="cl-dialog__lead">{t('Clients.renameLead')}</p>
        <form
          className="cl-dialog__form"
          onSubmit={(event) => {
            event.preventDefault();
            if (canSave) save.mutate();
          }}
        >
          <Field
            label={t('Clients.companyNameLabel')}
            hint={t('Clients.renameHint')}
            autoComplete="off"
            value={name}
            maxLength={190}
            onChange={(event) => setName(event.target.value)}
            required
          />
          {save.isError ? (
            <InlineAlert tone="danger" title={t('Clients.renameFailed')} live>
              {describePeopleError(save.error)}
            </InlineAlert>
          ) : null}
          <div className="cl-dialog__actions">
            <Button type="button" tone="outline" size="accessible" onClick={onClose}>
              {t('Clients.cancel')}
            </Button>
            <Button
              type="submit"
              tone="ink"
              size="accessible"
              disabled={!canSave}
              loading={save.isPending}
              loadingLabel={t('Clients.saving')}
            >
              {t('Clients.saveName')}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

/** Figma "Clients · Archive client company, confirm (2026-10-31 live-test fix)" 446:37514. */
function ArchiveCompanyDialog({
  api,
  organizationSlug,
  organization,
  onClose,
  onDone,
}: CompanyDialogProps) {
  const t = useClientsT();
  const titleId = useId();
  useEscape(onClose);

  const archive = useMutation({
    mutationFn: () => archiveClientOrganization(api, organizationSlug, organization.id),
    onSuccess: () => onDone(),
  });

  return (
    <div className="tm-command-palette__backdrop cl-backdrop">
      <div role="alertdialog" aria-modal="true" aria-labelledby={titleId} className="cl-dialog">
        <h2 id={titleId} className="cl-dialog__title">
          {t('Clients.archiveTitle', { name: organization.name })}
        </h2>
        <p className="cl-dialog__lead">{t('Clients.archiveBody')}</p>
        {archive.isError ? (
          <InlineAlert tone="danger" title={t('Clients.archiveFailed')} live>
            {describePeopleError(archive.error)}
          </InlineAlert>
        ) : null}
        <div className="cl-dialog__actions">
          <Button type="button" tone="outline" size="accessible" onClick={onClose}>
            {t('Clients.cancel')}
          </Button>
          <Button
            type="button"
            tone="destructive"
            size="accessible"
            loading={archive.isPending}
            loadingLabel={t('Clients.archiving')}
            onClick={() => archive.mutate()}
          >
            {t('Clients.archiveClient')}
          </Button>
        </div>
      </div>
    </div>
  );
}

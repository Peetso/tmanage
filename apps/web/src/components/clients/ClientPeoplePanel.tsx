'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert } from '@tmanage/ui';
import { useClientsT } from './InviteClientDialog';
import {
  listClientInvitations,
  listClientPeople,
  reissueClientInvitation,
  type ClientOrganization,
} from '../../lib/api/clients';
import type { InvitationSummary, IssuedInvitation } from '../../lib/api/invitations';
import type { ApiClient } from '../../lib/api/client';
import { describePeopleError, initialsOf } from '../screens/peopleShared';
import { NotDeliveredChip, StoppedInvitationNotice } from '../people/StoppedInvitationNotice';
import { ROLE_KEY } from '../screens/ClientsScreen';
import '../../styles/screens/clients.css';

export interface ClientPeoplePanelProps {
  api: ApiClient;
  organizationSlug: string;
  organization: ClientOrganization;
  now: number;
  /** A reissued link that was not e-mailed: the screen shows it to copy. */
  onIssued: (issued: IssuedInvitation) => void;
  /** "Check the address" on a stopped invitation opens the invite with that address. */
  onCheckAddress: (email: string) => void;
}

/** The query key prefix every read of one client company shares. */
export function clientCompanyKey(organizationSlug: string, clientOrganizationId: string) {
  return ['clients', organizationSlug, 'company', clientOrganizationId] as const;
}

export function isExpired(invitation: InvitationSummary, now: number): boolean {
  return invitation.status === 'expired' || Date.parse(invitation.expiresAt) <= now;
}

function daysSince(iso: string, now: number): number {
  const start = new Date(iso);
  const today = new Date(now);
  const startDay = Date.UTC(start.getFullYear(), start.getMonth(), start.getDate());
  const todayDay = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.max(0, Math.round((todayDay - startDay) / 86_400_000));
}

/**
 * The client page's People tab (ONEPAGE, B04; before it the whole page, Figma 446:37327): the
 * company's people by name, email and role, and its pending invitations with Resend.
 */
export function ClientPeoplePanel({
  api,
  organizationSlug,
  organization,
  now,
  onIssued,
  onCheckAddress,
}: ClientPeoplePanelProps) {
  const t = useClientsT();
  const queryClient = useQueryClient();
  const [resentEmail, setResentEmail] = useState<string | null>(null);
  const key = clientCompanyKey(organizationSlug, organization.id);

  const people = useQuery({
    queryKey: [...key, 'people'],
    queryFn: () => listClientPeople(api, organizationSlug, organization.id),
  });
  const invitations = useQuery({
    queryKey: [...key, 'invitations'],
    queryFn: () =>
      listClientInvitations(api, organizationSlug, organization.id, ['pending', 'expired']),
  });

  const resend = useMutation({
    mutationFn: (invitation: InvitationSummary) =>
      reissueClientInvitation(api, organizationSlug, invitation.id),
    onMutate: () => setResentEmail(null),
    onSuccess: (result, invitation) => {
      if (result.delivery !== 'sent') onIssued(result);
      else setResentEmail(invitation.email);
      void queryClient.invalidateQueries({ queryKey: ['clients', organizationSlug] });
    },
  });

  const members = people.data ?? [];
  const invites = [...(invitations.data ?? [])].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );
  const archived = organization.archivedAt != null;
  const roleLabel = (role: string) => (ROLE_KEY[role] ? t(ROLE_KEY[role]!) : role);

  const sentLabel = (invitation: InvitationSummary) => {
    if (isExpired(invitation, now)) return t('Clients.expired');
    if (invitation.email === resentEmail) return t('Clients.sentAgainJustNow');
    const days = daysSince(invitation.createdAt, now);
    if (days === 0) return t('Clients.sentToday');
    if (days === 1) return t('Clients.sentYesterday');
    return t('Clients.sentDaysAgo', { count: days });
  };

  return (
    <>
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
                const expired = isExpired(invitation, now);
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
                        onCheckAddress={() => onCheckAddress(invitation.email)}
                        onResend={() => resend.mutate(invitation)}
                      />
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
          <p className="cl-note">
            <span aria-hidden="true">◎</span>
            {t('Clients.companyNote', { name: organization.name })}
          </p>
        </section>
      </div>
    </>
  );
}

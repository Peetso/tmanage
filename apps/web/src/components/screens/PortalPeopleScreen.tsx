'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { ClientPortalShell } from '../shell/ClientPortalShell';
import { useSelectedPortalProject } from '../shell/PortalProjectSwitcher';
import { browserApiClient } from '../../lib/api/browser-client';
import { listPortalPeople, listPortalProjects } from '../../lib/api/portal';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import { Avatar, portalRoleLabel, Tag } from './PortalParts';
import { usePortalNames } from '../../lib/use-organization-names';
import { useT } from '../../lib/i18n/use-t';
import { useTOr } from '../../lib/i18n/use-t-or';
import { TeachingEmptyState } from '../help/TeachingEmptyState';

type Translate = ReturnType<typeof useT>;

export interface PortalPeopleScreenProps {
  organizationSlug: string;
  /** The client's own name leads the header. `22` §1. */
  clientName: string;
  providerName: string;
  client?: ApiClient;
}

/**
 * **CL-13 People** — who is on the work and who to ask.
 *
 * The studio's delivery team on the client's first shared project, as the client-visible roster
 * endpoint returns it (x142): a display name and a role, nothing more — no email, no internal
 * notes. Drawn as the handoff's CL-13: the contact to ask first in an ink-outlined card, the rest
 * of the team in a two-column grid of avatar cards.
 *
 * The contact is the first person whose role reads as a manager or lead, otherwise the first
 * person the API returned; the roster's own order is the studio's.
 */
export function PortalPeopleScreen({
  organizationSlug,
  clientName: passedClientName,
  providerName: passedProviderName,
  client,
}: PortalPeopleScreenProps) {
  const { clientName, providerName } = usePortalNames(
    organizationSlug,
    passedClientName,
    passedProviderName,
  );
  const api = client ?? browserApiClient();
  const t = useT();
  const tOr = useTOr();

  const projects = useQuery({
    queryKey: ['portal-projects', organizationSlug],
    queryFn: () => listPortalProjects(api, organizationSlug),
  });

  const project = useSelectedPortalProject(projects.data);
  const firstProjectId = project?.id;
  const people = useQuery({
    queryKey: ['portal-people', organizationSlug, firstProjectId],
    queryFn: () => listPortalPeople(api, organizationSlug, firstProjectId!),
    enabled: firstProjectId != null,
  });

  const roster = people.data ?? [];
  const contact = roster.find((person) => /manager|lead|owner|pm/i.test(person.role)) ?? roster[0];
  const others = roster.filter((person) => person !== contact);
  const firstName = contact?.displayName.split(' ')[0];

  return (
    <ClientPortalShell
      organizationSlug={organizationSlug}
      clientName={clientName}
      providerName={providerName}
      activeNavigationId="people"
      title={
        firstName
          ? `${t('PortalPeopleScreen.askPrefix')} ${firstName} ${t('PortalPeopleScreen.askSuffix')}`
          : t('PortalPeopleScreen.people')
      }
      eyebrow={
        project
          ? `${t('PortalPeopleScreen.peopleOn')} ${project.name}`
          : t('PortalPeopleScreen.people')
      }
    >
      <div className="tm-pt tm-pt--compact">
        {projects.isError ? (
          <InlineAlert tone="danger" title={t('PortalPeopleScreen.couldNotLoadPortal')} live>
            {describe(projects.error, t)}
          </InlineAlert>
        ) : null}

        {projects.isPending ? (
          <LoadingRegion label={t('PortalPeopleScreen.loadingProject')}>
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        <section className="tm-pt-col tm-pt-people" aria-labelledby="tm-portal-people">
          <h2 id="tm-portal-people" className="tm-pt-eyebrow">
            {project
              ? `${providerName} · ${roster.length} ${roster.length === 1 ? t('PortalPeopleScreen.person') : t('PortalPeopleScreen.people_plural')}`
              : t('PortalPeopleScreen.yourTeam')}
          </h2>

          {!projects.isPending && project == null ? (
            <p className="tm-pt-card tm-pt-card--dashed tm-pt-card__body">
              {t('PortalPeopleScreen.nothingSharedLead')} {providerName}{' '}
              {t('PortalPeopleScreen.nothingSharedTail')}
            </p>
          ) : null}

          {people.isError ? (
            <InlineAlert tone="danger" title={t('PortalPeopleScreen.couldNotLoadTeam')} live>
              {describe(people.error, t)}
            </InlineAlert>
          ) : null}

          {people.isPending && firstProjectId != null ? (
            <LoadingRegion label={t('PortalPeopleScreen.loadingTeam')}>
              <Skeleton height="var(--row)" />
              <Skeleton height="var(--row)" />
            </LoadingRegion>
          ) : null}

          {project != null && !people.isPending && !people.isError && roster.length === 0 ? (
            <TeachingEmptyState
              title={t('teachEmpty.portalPeopleTitle')}
              explanation={t('teachEmpty.portalPeopleBody').replace('{studio}', providerName)}
            />
          ) : null}

          {contact ? (
            <ul
              className="tm-pt-list"
              aria-label={`${t('PortalPeopleScreen.yourTeamOn')} ${project?.name ?? t('PortalPeopleScreen.theProject')}`}
            >
              <li className="tm-pt-person-card tm-pt-person-card--lead">
                <Avatar name={contact.displayName} tone="soft" size="lg" />
                <div className="tm-pt-item__main">
                  <div className="tm-pt-action__meta">
                    <p className="tm-pt-person-card__name">{contact.displayName}</p>
                    <Tag tone="lime">{t('PortalPeopleScreen.yourContact')}</Tag>
                  </div>
                  <p className="tm-pt-person-card__role">{portalRoleLabel(contact.role, tOr)}</p>
                </div>
                <Link
                  className="tm-pt-btn tm-pt-btn--ink"
                  href={`/${organizationSlug}/portal/requests/new`}
                >
                  {t('PortalPeopleScreen.askForSomething')}
                </Link>
              </li>
              {others.length > 0 ? (
                <li>
                  <ul className="tm-pt-grid">
                    {others.map((person) => (
                      <li
                        key={`${person.displayName}:${person.role}`}
                        className="tm-pt-person-card"
                      >
                        <Avatar name={person.displayName} tone="soft" size="md" />
                        <div className="tm-pt-item__main">
                          <p className="tm-pt-person-card__name">{person.displayName}</p>
                          <p className="tm-pt-person-card__role">
                            {portalRoleLabel(person.role, tOr)}
                          </p>
                        </div>
                      </li>
                    ))}
                  </ul>
                </li>
              ) : null}
            </ul>
          ) : null}
        </section>
      </div>
    </ClientPortalShell>
  );
}

function describe(error: unknown, t: Translate): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return t('PortalPeopleScreen.portalNotAnswering');
  return t('PortalPeopleScreen.genericError');
}

'use client';

import { useQuery } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { ClientPortalShell } from '../shell/ClientPortalShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { listPortalPeople, listPortalProjects } from '../../lib/api/portal';
import type { PortalPerson } from '../../lib/api/portal';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface PortalPeopleScreenProps {
  organizationSlug: string;
  /** The client's own name leads the header. `22` §1. */
  clientName: string;
  providerName: string;
  client?: ApiClient;
}

/**
 * **People** — the client-portal team screen (`22-SCREEN-BY-SCREEN` §1, x142).
 *
 * ## Who, not how much
 *
 * `12-PERMISSION-MATRIX` §4 excludes staff from the client projection and permits "approved
 * contacts": a curated name-and-role list. So this screen shows exactly that — the people at
 * {providerName} working on the client's project, each as a name and a role — and cannot show
 * more, because `PortalPerson` carries no email, no id and no "last seen". Contacting a person,
 * avatars and a cross-project directory are deferred (NS-13); this screen names none of them
 * rather than promising them.
 *
 * ## Keyed on the first shared project
 *
 * The endpoint names the project in the path, so there is nothing to ask for until the projects
 * list has answered. People is enabled only once the first shared project's id is known — the same
 * shape `ClientOverviewScreen` uses for the updates timeline. The API returns 404 for a project
 * the client cannot read, which surfaces here as the error state rather than an empty list.
 */
export function PortalPeopleScreen({
  organizationSlug,
  clientName,
  providerName,
  client,
}: PortalPeopleScreenProps) {
  const api = client ?? browserApiClient();

  const projects = useQuery({
    queryKey: ['portal-projects', organizationSlug],
    queryFn: () => listPortalProjects(api, organizationSlug),
  });

  const firstProjectId = projects.data?.[0]?.id;
  const people = useQuery({
    queryKey: ['portal-people', organizationSlug, firstProjectId],
    queryFn: () => listPortalPeople(api, organizationSlug, firstProjectId!),
    enabled: firstProjectId != null,
  });

  const project = projects.data?.[0];
  const roster = people.data ?? [];

  return (
    <ClientPortalShell
      organizationSlug={organizationSlug}
      clientName={clientName}
      providerName={providerName}
      {...(project ? { projectName: project.name } : {})}
      activeNavigationId="people"
      title="People"
      description={`Who you are working with at ${providerName}.`}
    >
      {projects.isError ? (
        <InlineAlert tone="danger" title="Could not load your portal" live>
          {describe(projects.error)}
        </InlineAlert>
      ) : null}

      {projects.isPending ? (
        <LoadingRegion label="Loading your project.">
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      <section className="tm-panel tm-stack" aria-labelledby="tm-portal-people">
        <h2 id="tm-portal-people" className="tm-eyebrow">
          {project ? `Your team on ${project.name}` : 'Your team'}
        </h2>

        {!projects.isPending && project == null ? (
          <p className="tm-prose">
            Nothing has been shared with you yet. {providerName} decides what appears here, and they
            will tell you when a project is ready to see.
          </p>
        ) : null}

        {people.isError ? (
          <InlineAlert tone="danger" title="Could not load your team" live>
            {describe(people.error)}
          </InlineAlert>
        ) : null}

        {people.isPending && firstProjectId != null ? (
          <LoadingRegion label="Loading your team.">
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {project != null && !people.isPending && !people.isError ? (
          roster.length === 0 ? (
            <p className="tm-prose">
              No contacts have been shared for this project yet. {providerName} chooses who appears
              here, and will introduce your team as the work starts.
            </p>
          ) : (
            <ul className="tm-list tm-stack tm-stack--tight">
              {roster.map((person) => (
                <li key={`${person.displayName}:${person.role}`}>
                  <strong>{person.displayName}</strong>{' '}
                  <span className="tm-prose">{roleLabel(person.role)}</span>
                </li>
              ))}
            </ul>
          )
        ) : null}
      </section>
    </ClientPortalShell>
  );
}

/** A role is a short label; the API sends the stored value, so present it as it stands. */
function roleLabel(role: PortalPerson['role']): string {
  return role;
}

function describe(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The portal is not answering. Try again shortly.';
  return 'Something went wrong. Try again.';
}

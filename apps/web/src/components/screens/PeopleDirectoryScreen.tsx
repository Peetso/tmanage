'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Badge, InlineAlert, LoadingRegion, SearchField, Skeleton, StatusDot } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { listPeople } from '../../lib/api/people';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import { describeInternalRole } from '../../lib/roles';
import type { ApiClient } from '../../lib/api/client';

export interface PeopleDirectoryScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** Injected in tests. Defaults to the browser client. */
  client?: ApiClient;
}

/**
 * **People & capacity** — module 14, audit #4.
 *
 * The `/people` destination on the internal rail used to resolve to `PlannedInternalScreen`: a
 * named page with nothing behind it. This is the screen that answers it — everyone in the
 * organization, by name, with the role they hold, whether they are active, and how many projects
 * they are on. It is the read every member uses to see who is here and plan capacity; the
 * Administration write boundary (offboarding) lives on its own sub-route.
 *
 * The search is the server's: the list is one page, so typing a name asks the API to narrow the
 * roster rather than filtering whatever page the browser happens to hold.
 */
export function PeopleDirectoryScreen({
  organizationSlug,
  organizationName,
  client,
}: PeopleDirectoryScreenProps) {
  const api = client ?? browserApiClient();
  const [search, setSearch] = useState('');
  const term = search.trim();

  const people = useQuery({
    queryKey: ['people-directory', organizationSlug, term],
    queryFn: () => listPeople(api, organizationSlug, term === '' ? {} : { q: term }),
  });

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="people"
      title="People"
      description="Everyone in your organization, the role they hold, and how many projects they are on."
    >
      <section className="tm-panel tm-panel--quiet tm-stack" aria-labelledby="tm-people-search">
        <h2 id="tm-people-search" className="tm-eyebrow">
          Find someone
        </h2>
        <form className="tm-stack" role="search" onSubmit={(event) => event.preventDefault()}>
          <SearchField
            label="Search people by name"
            labelVisible
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Type a name"
          />
        </form>
      </section>

      <section className="tm-stack" aria-labelledby="tm-people-list">
        <h2 id="tm-people-list" className="tm-eyebrow">
          People
        </h2>

        {people.isPending ? (
          <LoadingRegion
            label="Loading the people in your organization."
            className="tm-stack tm-stack--tight"
          >
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {people.isError ? (
          <InlineAlert tone="danger" title="Could not load the people" live>
            {describe(people.error)}
          </InlineAlert>
        ) : null}

        {people.isSuccess ? (
          people.data.people.length === 0 ? (
            <InlineAlert tone="neutral">
              {term === ''
                ? 'Nobody is in this organization yet.'
                : `No active member matches “${term}”.`}
            </InlineAlert>
          ) : (
            <ul className="tm-stack tm-list" aria-label="People in this organization">
              {people.data.people.map((person) => (
                <li key={person.userId} className="tm-panel tm-stack tm-stack--tight">
                  <div className="tm-row">
                    <span>{person.displayName}</span>
                    <Badge>{describeInternalRole(person.role).label}</Badge>
                    <span className="tm-push-end">
                      <StatusDot tone="success">Active</StatusDot>
                    </span>
                  </div>
                  <div className="tm-row">
                    <span className="tm-muted">
                      {person.projectCount === 1
                        ? 'On 1 project'
                        : `On ${person.projectCount} projects`}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )
        ) : null}

        {people.isSuccess && people.data.nextAfter !== null ? (
          <InlineAlert tone="neutral">
            More people match than fit on one page. Narrow the list with a name above.
          </InlineAlert>
        ) : null}
      </section>
    </AppShell>
  );
}

/** Turn a thrown value into a sentence a person can act on. Never leaks a stack or a cause. */
function describe(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Check that it is running.';
  return 'Something went wrong. Try again.';
}

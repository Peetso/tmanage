'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, SearchField, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { listPeople } from '../../lib/api/people';
import type { PersonSummary } from '../../lib/api/people';
import { listTeams } from '../../lib/api/people-teams';
import { listOrganizations } from '../../lib/api/organizations';
import { describeInternalRole } from '../../lib/roles';
import { useHydrated } from '../../lib/use-hydrated';
import type { ApiClient } from '../../lib/api/client';
import { describePeopleError, initialsOf } from './peopleShared';
import '../../styles/screens/people.css';

export interface PeopleDirectoryScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** Injected in tests. Defaults to the browser client. */
  client?: ApiClient;
}

/** Owner and org admin may invite; everyone else is never offered a button they would be refused. */
const INVITING_ROLES = new Set(['owner', 'org_admin', 'admin']);

/**
 * **People & capacity** — module 14, audit #4; drawn as PEO-01 "Directory".
 *
 * Everyone in the organization, by name, with the role they hold, whether they are active, and how
 * many projects they are on. The design's collection: a mono eyebrow and a 44px headline, the search
 * capsule and "Invite person" at the end of the header, a row of filter chips, the roster as a
 * bordered table, and a context column (the selected person, the teams, and what the directory
 * never lists).
 *
 * Only what the API returns is drawn. The frame also shows teams per row, open commitments and
 * declared availability; the people read does not carry those, so those columns are not invented —
 * the role filter and the role's own authority (from `lib/roles`) stand where the API has data.
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
  // The standing `useHydrated` barrier: the search ships disabled in the server render, so a name
  // typed before hydration cannot sit in the DOM while the roster query still searches for nothing.
  const hydrated = useHydrated();
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const term = search.trim();

  const people = useQuery({
    queryKey: ['people-directory', organizationSlug, term],
    queryFn: () => listPeople(api, organizationSlug, term === '' ? {} : { q: term }),
  });

  const teams = useQuery({
    queryKey: ['people-teams', organizationSlug],
    queryFn: () => listTeams(api, organizationSlug),
  });

  const organizations = useQuery({
    queryKey: ['shell', 'organizations'],
    queryFn: () => listOrganizations(api),
    staleTime: 5 * 60_000,
  });
  const myRole = Array.isArray(organizations.data)
    ? organizations.data.find((org) => org.slug === organizationSlug)?.role
    : undefined;
  const canInvite = myRole !== undefined && INVITING_ROLES.has(myRole);

  const roster = useMemo(
    () => (people.isSuccess ? people.data.people : ([] as readonly PersonSummary[])),
    [people.isSuccess, people.data],
  );
  const roles = useMemo(() => [...new Set(roster.map((person) => person.role))], [roster]);
  const shown =
    roleFilter === null ? roster : roster.filter((person) => person.role === roleFilter);
  const selected = shown.find((person) => person.userId === selectedId) ?? shown[0];
  const teamList = Array.isArray(teams.data?.teams) ? teams.data.teams : [];

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="people"
      eyebrow={
        people.isSuccess
          ? `People · Directory · ${roster.length} ${roster.length === 1 ? 'person' : 'people'}`
          : 'People · Directory'
      }
      title="Who owns what, and who to ask"
      actions={
        <div className="ppl-header-actions">
          <form role="search" onSubmit={(event) => event.preventDefault()}>
            <fieldset className="tm-fieldset" disabled={!hydrated}>
              <SearchField
                className="ppl-search"
                label="Search people by name"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Name"
              />
            </fieldset>
          </form>
          {canInvite ? (
            <Link
              href={`/${organizationSlug}/onboarding/team`}
              className="tm-button tm-button--ink ppl-cta"
            >
              Invite person
            </Link>
          ) : null}
        </div>
      }
    >
      <div className="ppl-screen">
        <div className="ppl-filters" role="group" aria-label="Filter by role">
          <button
            type="button"
            className="tm-chip"
            aria-pressed={roleFilter === null}
            onClick={() => setRoleFilter(null)}
          >
            Everyone
          </button>
          {roles.map((role) => (
            <button
              key={role}
              type="button"
              className="tm-chip"
              aria-pressed={roleFilter === role}
              onClick={() => setRoleFilter(role)}
            >
              {describeInternalRole(role).label}
            </button>
          ))}
          <div className="ppl-filters__end">
            <span className="ppl-mono">Sorted by name</span>
          </div>
        </div>

        <div className="ppl-body">
          <section className="ppl-card ppl-card--flush ppl-main" aria-labelledby="tm-people-list">
            <h2 id="tm-people-list" className="tm-visually-hidden">
              People
            </h2>
            <div className="ppl-table-head" aria-hidden="true">
              <span className="ppl-col-person">Person</span>
              <span className="ppl-col-role">Role and authority</span>
              <span className="ppl-col-projects">On projects</span>
              <span className="ppl-col-status">Status</span>
            </div>

            {people.isPending ? (
              <LoadingRegion
                label="Loading the people in your organization."
                className="tm-stack tm-stack--tight ppl-loading"
              >
                <Skeleton height="var(--row)" />
                <Skeleton height="var(--row)" />
              </LoadingRegion>
            ) : null}

            {people.isError ? (
              <div className="ppl-loading">
                <InlineAlert tone="danger" title="Could not load the people" live>
                  {describePeopleError(people.error)}
                </InlineAlert>
              </div>
            ) : null}

            {people.isSuccess ? (
              <>
                <p className="ppl-mono ppl-group">
                  {roleFilter === null ? 'Everyone' : describeInternalRole(roleFilter).label} ·{' '}
                  {shown.length}
                </p>
                {shown.length === 0 ? (
                  <div className="ppl-loading">
                    <InlineAlert tone="neutral">
                      {term === ''
                        ? 'Nobody is in this organization yet.'
                        : `No active member matches “${term}”.`}
                    </InlineAlert>
                  </div>
                ) : null}
                <ul className="ppl-people" aria-label="People in this organization">
                  {shown.map((person) => (
                    <PersonRow
                      key={person.userId}
                      person={person}
                      selected={person.userId === selected?.userId}
                      onSelect={() => setSelectedId(person.userId)}
                    />
                  ))}
                </ul>
              </>
            ) : null}

            {people.isSuccess && people.data.nextAfter !== null ? (
              <div className="ppl-loading">
                <InlineAlert tone="neutral">
                  More people match than fit on one page. Narrow the list with a name above.
                </InlineAlert>
              </div>
            ) : null}
          </section>

          <div className="ppl-aside">
            {selected ? <SelectedPerson person={selected} /> : null}

            <section className="ppl-card ppl-card--tight" aria-labelledby="tm-people-teams">
              <h2 id="tm-people-teams" className="ppl-mono">
                Teams
              </h2>
              {teams.isPending ? (
                <LoadingRegion label="Loading the teams.">
                  <Skeleton height="40px" />
                </LoadingRegion>
              ) : teams.isError ? (
                <p className="ppl-note">The teams could not be loaded just now.</p>
              ) : teamList.length === 0 ? (
                <p className="ppl-note">
                  No teams yet. <Link href={`/${organizationSlug}/people/teams`}>Open teams</Link>
                </p>
              ) : (
                <ul className="ppl-soft-list">
                  {teamList.map((team) => (
                    <li key={team.id}>
                      <Link href={`/${organizationSlug}/people/teams`} className="ppl-soft-row">
                        {team.name}
                        <span className="ppl-soft-row__end">{team.memberCount}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section
              className="ppl-card ppl-card--tight ppl-card--ink"
              aria-labelledby="tm-people-never"
            >
              <h2 id="tm-people-never" className="ppl-mono">
                What this directory does not list
              </h2>
              <p className="ppl-note ppl-note--ink">
                No output counts, no activity status, no last-seen. Roles and the projects someone
                is on are the only things shown, and both are set on record, not inferred.
              </p>
            </section>
          </div>
        </div>
      </div>
    </AppShell>
  );
}

function PersonRow({
  person,
  selected,
  onSelect,
}: {
  person: PersonSummary;
  selected: boolean;
  onSelect: () => void;
}) {
  const role = describeInternalRole(person.role);
  return (
    <li className="ppl-person" data-selected={selected}>
      <span className="ppl-col-person">
        <button
          type="button"
          className="ppl-person__who"
          aria-pressed={selected}
          onClick={onSelect}
        >
          <span className="ppl-avatar" aria-hidden="true">
            {initialsOf(person.displayName)}
          </span>
          <span>
            <span className="ppl-person__name">{person.displayName}</span>
            <span className="ppl-person__sub">■ internal</span>
          </span>
        </button>
      </span>
      <span className="ppl-col-role">
        <span className="ppl-cell-strong">{role.label}</span>
        {role.grants[0] ? <span className="ppl-cell-sub">{role.grants[0]}</span> : null}
      </span>
      <span className="ppl-col-projects ppl-cell-strong">
        {/* The design reads "4 projects"; the accessible text keeps the full sentence. */}
        <span className="tm-visually-hidden">
          {person.projectCount === 1 ? 'On 1 project' : `On ${person.projectCount} projects`}
        </span>
        <span aria-hidden="true">
          {person.projectCount === 1 ? '1 project' : `${person.projectCount} projects`}
        </span>
      </span>
      <span className="ppl-col-status">
        <span
          className={person.status === 'active' ? 'ppl-status' : 'ppl-status ppl-status--quiet'}
        >
          {person.status === 'active' ? 'Active' : person.status}
        </span>
      </span>
    </li>
  );
}

function SelectedPerson({ person }: { person: PersonSummary }) {
  const role = describeInternalRole(person.role);
  return (
    <section
      className="ppl-card ppl-card--tight ppl-card--selected"
      aria-label={`Selected: ${person.displayName}`}
    >
      <div className="ppl-person-card__who">
        <span className="ppl-avatar ppl-avatar--56" aria-hidden="true">
          {initialsOf(person.displayName)}
        </span>
        <div>
          <p className="ppl-person-card__name">{person.displayName}</p>
          <p className="ppl-person-card__role">
            {role.label} · on {person.projectCount}{' '}
            {person.projectCount === 1 ? 'project' : 'projects'}
          </p>
        </div>
      </div>
      <hr className="ppl-rule" />
      <p className="ppl-mono">What this role may decide</p>
      {role.grants[0] ? <p className="ppl-lime-block">{role.grants[0]}</p> : null}
      <p className="ppl-note ppl-note--body">{role.withholds}</p>
    </section>
  );
}

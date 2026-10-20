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
import { useT } from '../../lib/i18n/use-t';
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
 * The roster is grouped by team (the first team a person is assigned to; nobody is listed twice)
 * with a "No team" group last, and each row carries the open work the person owns (with how much is
 * past due) and what they have **declared** for the next two weeks — never inferred: no window
 * declared reads "Full week". The role's own authority comes from `lib/roles`.
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
  const t = useT();
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
  const groups = groupByTeam(shown);

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="people"
      eyebrow={
        people.isSuccess
          ? `${t('PeopleDirectoryScreen.eyebrow')} · ${roster.length} ${t('PeopleDirectoryScreen.internalSuffix')}`
          : t('PeopleDirectoryScreen.eyebrow')
      }
      title={t('PeopleDirectoryScreen.title')}
      actions={
        <div className="ppl-header-actions">
          <form role="search" onSubmit={(event) => event.preventDefault()}>
            <fieldset className="tm-fieldset" disabled={!hydrated}>
              <SearchField
                className="ppl-search"
                label={t('PeopleDirectoryScreen.searchLabel')}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={t('PeopleDirectoryScreen.searchPlaceholder')}
              />
            </fieldset>
          </form>
          {canInvite ? (
            <Link
              href={`/${organizationSlug}/onboarding/team`}
              className="tm-button tm-button--ink ppl-cta"
            >
              {t('PeopleDirectoryScreen.invitePerson')}
            </Link>
          ) : null}
        </div>
      }
    >
      <div className="ppl-screen">
        <div
          className="ppl-filters"
          role="group"
          aria-label={t('PeopleDirectoryScreen.filterByRole')}
        >
          <button
            type="button"
            className="tm-chip"
            aria-pressed={roleFilter === null}
            onClick={() => setRoleFilter(null)}
          >
            {t('PeopleDirectoryScreen.everyone')}
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
            <span className="ppl-mono">{t('PeopleDirectoryScreen.groupedByTeam')}</span>
            <span className="ppl-static-chip">{t('PeopleDirectoryScreen.sortName')}</span>
          </div>
        </div>

        <div className="ppl-body">
          <section className="ppl-card ppl-card--flush ppl-main" aria-labelledby="tm-people-list">
            <h2 id="tm-people-list" className="tm-visually-hidden">
              {t('PeopleDirectoryScreen.peopleHeading')}
            </h2>
            <div className="ppl-table-head" aria-hidden="true">
              <span className="ppl-col-person">{t('PeopleDirectoryScreen.colPerson')}</span>
              <span className="ppl-col-role">{t('PeopleDirectoryScreen.colRole')}</span>
              <span className="ppl-col-projects">{t('PeopleDirectoryScreen.colProjects')}</span>
              <span className="ppl-col-commit">{t('PeopleDirectoryScreen.colCommitments')}</span>
              <span className="ppl-col-declared">{t('PeopleDirectoryScreen.colDeclared')}</span>
            </div>

            {people.isPending ? (
              <LoadingRegion
                label={t('PeopleDirectoryScreen.loading')}
                className="tm-stack tm-stack--tight ppl-loading"
              >
                <Skeleton height="var(--row)" />
                <Skeleton height="var(--row)" />
              </LoadingRegion>
            ) : null}

            {people.isError ? (
              <div className="ppl-loading">
                <InlineAlert tone="danger" title={t('PeopleDirectoryScreen.loadError')} live>
                  {describePeopleError(people.error)}
                </InlineAlert>
              </div>
            ) : null}

            {people.isSuccess ? (
              <>
                {shown.length === 0 ? (
                  <div className="ppl-loading">
                    <InlineAlert tone="neutral">
                      {term === ''
                        ? t('PeopleDirectoryScreen.emptyNobody')
                        : `${t('PeopleDirectoryScreen.noMatch')} “${term}”.`}
                    </InlineAlert>
                  </div>
                ) : null}
                <ul className="ppl-people" aria-label={t('PeopleDirectoryScreen.peopleListLabel')}>
                  {groups.map((group) => (
                    <li key={group.key} className="ppl-people__group">
                      <p className="ppl-mono ppl-group" id={`ppl-group-${group.key}`}>
                        {group.label} · {group.people.length}
                      </p>
                      <ul className="ppl-people" aria-labelledby={`ppl-group-${group.key}`}>
                        {group.people.map((person) => (
                          <PersonRow
                            key={person.userId}
                            person={person}
                            selected={person.userId === selected?.userId}
                            onSelect={() => setSelectedId(person.userId)}
                          />
                        ))}
                      </ul>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}

            {people.isSuccess && people.data.nextAfter !== null ? (
              <div className="ppl-loading">
                <InlineAlert tone="neutral">{t('PeopleDirectoryScreen.morePeople')}</InlineAlert>
              </div>
            ) : null}
          </section>

          <div className="ppl-aside">
            {selected ? (
              <SelectedPerson person={selected} organizationSlug={organizationSlug} />
            ) : null}

            <section className="ppl-card ppl-card--tight" aria-labelledby="tm-people-teams">
              <h2 id="tm-people-teams" className="ppl-mono">
                {t('PeopleDirectoryScreen.teamsHeading')}
              </h2>
              {teams.isPending ? (
                <LoadingRegion label={t('PeopleDirectoryScreen.loadingTeams')}>
                  <Skeleton height="40px" />
                </LoadingRegion>
              ) : teams.isError ? (
                <p className="ppl-note">{t('PeopleDirectoryScreen.teamsError')}</p>
              ) : teamList.length === 0 ? (
                <p className="ppl-note">
                  {t('PeopleDirectoryScreen.noTeams')}{' '}
                  <Link href={`/${organizationSlug}/people/teams`}>
                    {t('PeopleDirectoryScreen.openTeams')}
                  </Link>
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
                {t('PeopleDirectoryScreen.neverTitle')}
              </h2>
              <p className="ppl-note ppl-note--ink">{t('PeopleDirectoryScreen.neverBody')}</p>
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
  const t = useT();
  const role = describeInternalRole(person.role);
  const overdue = person.overdueCommitments ?? 0;
  const declared = describeDeclared(person.declared ?? null, new Date());
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
          {t('PeopleDirectoryScreen.onPrefix')} {person.projectCount}{' '}
          {person.projectCount === 1
            ? t('PeopleDirectoryScreen.projectWord')
            : t('PeopleDirectoryScreen.projectsWord')}
        </span>
        <span aria-hidden="true">
          {person.projectCount}{' '}
          {person.projectCount === 1
            ? t('PeopleDirectoryScreen.projectWord')
            : t('PeopleDirectoryScreen.projectsWord')}
        </span>
      </span>
      <span className="ppl-col-commit">
        <span className="ppl-commit">
          <span className="tm-visually-hidden">
            {t('PeopleDirectoryScreen.openCommitmentsLabel')}{' '}
          </span>
          {person.openCommitments ?? '—'}
        </span>
        {overdue > 0 ? (
          <span className="ppl-pill ppl-pill--warning">
            {overdue} {t('PeopleDirectoryScreen.overdue')}
          </span>
        ) : null}
      </span>
      <span className="ppl-col-declared ppl-cell-strong">
        <span className="tm-visually-hidden">{t('PeopleDirectoryScreen.declaredLabel')} </span>
        {person.declared === undefined ? (
          '—'
        ) : declared === null ? (
          t('PeopleDirectoryScreen.fullWeek')
        ) : (
          <span className="ppl-declared-off" title={declared.title}>
            {declared.label}
          </span>
        )}
      </span>
    </li>
  );
}

function SelectedPerson({
  person,
  organizationSlug,
}: {
  person: PersonSummary;
  organizationSlug: string;
}) {
  const t = useT();
  const role = describeInternalRole(person.role);
  const team = person.teams?.[0]?.name;
  return (
    <section
      className="ppl-card ppl-card--tight ppl-card--selected"
      aria-label={`${t('PeopleDirectoryScreen.selectedPrefix')}: ${person.displayName}`}
    >
      <div className="ppl-person-card__who">
        <span className="ppl-avatar ppl-avatar--56" aria-hidden="true">
          {initialsOf(person.displayName)}
        </span>
        <div>
          <p className="ppl-person-card__name">{person.displayName}</p>
          <p className="ppl-person-card__role">
            {role.label} ·{' '}
            {team ??
              `${t('PeopleDirectoryScreen.onLowerPrefix')} ${person.projectCount} ${
                person.projectCount === 1
                  ? t('PeopleDirectoryScreen.projectWord')
                  : t('PeopleDirectoryScreen.projectsWord')
              }`}
          </p>
        </div>
      </div>
      <hr className="ppl-rule" />
      <p className="ppl-mono">{t('PeopleDirectoryScreen.roleDecide')}</p>
      {role.grants[0] ? <p className="ppl-lime-block">{role.grants[0]}</p> : null}
      <p className="ppl-note ppl-note--body">{role.withholds}</p>
      {person.membershipId ? (
        <div className="ppl-person-card__actions">
          <Link
            href={`/${organizationSlug}/people/${encodeURIComponent(person.membershipId)}`}
            className="tm-button tm-button--ink"
          >
            {t('PeopleDirectoryScreen.openProfile')}
          </Link>
        </div>
      ) : null}
    </section>
  );
}

interface TeamGroup {
  readonly key: string;
  readonly label: string;
  readonly people: readonly PersonSummary[];
}

/**
 * PEO-01's grouping: each person under the first team they are assigned to (the API lists teams by
 * name), groups by team name, and everyone without a team in a last "No team" group. A person is
 * listed once, so the counts add up to the roster.
 */
export function groupByTeam(people: readonly PersonSummary[]): readonly TeamGroup[] {
  const byTeam = new Map<string, { label: string; people: PersonSummary[] }>();
  const unassigned: PersonSummary[] = [];
  for (const person of people) {
    const team = person.teams?.[0];
    if (!team) {
      unassigned.push(person);
      continue;
    }
    const group = byTeam.get(team.id) ?? { label: team.name, people: [] };
    group.people.push(person);
    byTeam.set(team.id, group);
  }
  const groups: TeamGroup[] = [...byTeam.entries()]
    .sort(([, a], [, b]) => a.label.localeCompare(b.label))
    .map(([key, group]) => ({ key, label: group.label, people: group.people }));
  if (unassigned.length > 0) {
    groups.push({ key: 'no-team', label: 'No team', people: unassigned });
  }
  return groups;
}

const DAY_MS = 86_400_000;

function shortDate(isoDate: string): string {
  return new Date(`${isoDate}T00:00:00Z`).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}

function weekday(isoDate: string): string {
  return new Date(`${isoDate}T00:00:00Z`).toLocaleDateString('en-GB', {
    weekday: 'short',
    timeZone: 'UTC',
  });
}

/**
 * The DECLARED cell: what the person declared, in the design's short form — "Off Thu–Fri" for a
 * window ahead, "Off until Fri" for one already running, "Off Thu" for a single day. `null` means
 * nothing declared, which the caller shows as "Full week". The title keeps the full dates and kind.
 */
export function describeDeclared(
  declared: PersonSummary['declared'] | null,
  now: Date,
): { label: string; title: string } | null {
  if (!declared) return null;
  const today = now.toISOString().slice(0, 10);
  const { startDate, endDate, kind } = declared;
  const title = `${kind} · ${startDate} to ${endDate}`;
  const span = (Date.parse(endDate) - Date.parse(startDate)) / DAY_MS;
  if (span >= 7) return { label: `Off until ${shortDate(endDate)}`, title };
  if (startDate <= today) {
    return { label: endDate === today ? 'Off today' : `Off until ${weekday(endDate)}`, title };
  }
  if (startDate === endDate) return { label: `Off ${weekday(startDate)}`, title };
  return { label: `Off ${weekday(startDate)}–${weekday(endDate)}`, title };
}

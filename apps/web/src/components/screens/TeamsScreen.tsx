'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { fetchTeam, listTeams } from '../../lib/api/people-teams';
import type { TeamDetailView, TeamView } from '../../lib/api/people-teams';
import { describeInternalRole } from '../../lib/roles';
import type { ApiClient } from '../../lib/api/client';
import { describePeopleError, initialsOf } from './peopleShared';
import '../../styles/screens/people.css';

export interface TeamsScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** Injected in tests. Defaults to the browser client. */
  client?: ApiClient;
}

/**
 * **People teams** — x262, the "teams" surface of module 14 (38-MODULE-MAP §People), drawn as
 * PEO-03 "Team detail". It reads `GET …/people/teams` (the team list) and `GET …/people/teams/:id`
 * (the selected team's members) — both gated on the server by `work.read`.
 *
 * The frame's two columns: the team list as the soft member cards on the left (the selected one
 * carries the ink leading edge), and the selected team's roster as the bordered inner table on the
 * right. The first team is selected on arrival so the page is never an empty half.
 *
 * The decisions are the sibling internal screens':
 * 1. **Authorization is the API's.** A refusal becomes a sentence in the card's own alert; the
 *    screen never guesses a capability of its own and never renders blank on a refusal.
 * 2. **No invented data.** Teams, member counts and rosters are the API's projection. The frame's
 *    WIP limit, commitments and cover rows have no read behind them yet, so they are not drawn.
 */
export function TeamsScreen({ organizationSlug, organizationName, client }: TeamsScreenProps) {
  const api = client ?? browserApiClient();
  const [chosenId, setChosenId] = useState<string | null>(null);

  const teams = useQuery({
    queryKey: ['people-teams', organizationSlug],
    queryFn: () => listTeams(api, organizationSlug),
  });

  const teamList = teams.isSuccess && Array.isArray(teams.data.teams) ? teams.data.teams : [];
  const selectedId = chosenId ?? teamList[0]?.id ?? null;

  const detail = useQuery({
    queryKey: ['people-team', organizationSlug, selectedId],
    queryFn: () => fetchTeam(api, organizationSlug, selectedId as string),
    enabled: selectedId !== null,
  });

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="people"
      eyebrow={
        teams.isSuccess
          ? `People · Teams · ${teamList.length} ${teamList.length === 1 ? 'team' : 'teams'}`
          : 'People · Teams'
      }
      title="Teams"
      description="Named teams in this organization and who is on them."
    >
      <div className="ppl-screen">
        <div className="ppl-body ppl-body--wide-gap">
          <div className="ppl-aside ppl-aside--392">
            <section className="ppl-card" aria-labelledby="tm-teams-heading">
              <h2 id="tm-teams-heading" className="ppl-mono">
                Teams
              </h2>

              {teams.isPending ? (
                <LoadingRegion label="Loading the teams." className="tm-stack tm-stack--tight">
                  <Skeleton height="var(--row)" />
                  <Skeleton height="var(--row)" />
                </LoadingRegion>
              ) : null}

              {teams.isError ? (
                <InlineAlert tone="danger" title="Could not load the teams" live>
                  {describePeopleError(teams.error)}
                </InlineAlert>
              ) : null}

              {teams.isSuccess ? (
                <TeamsList teams={teamList} selectedId={selectedId} onSelect={setChosenId} />
              ) : null}
            </section>

            <section className="ppl-card" aria-labelledby="tm-teams-how">
              <h2 id="tm-teams-how" className="ppl-card__title">
                How a team is shaped
              </h2>
              <p className="ppl-dashed-note">
                A team is a named group of members. Membership is set on record by an organization
                admin; nothing here is inferred from who works with whom.
              </p>
            </section>
          </div>

          <div className="ppl-main">
            {selectedId !== null ? (
              <section className="ppl-card" aria-labelledby="tm-team-detail-heading">
                {detail.isPending ? (
                  <>
                    <h2 id="tm-team-detail-heading" className="ppl-card__title ppl-card__title--lg">
                      Team detail
                    </h2>
                    <LoadingRegion label="Loading the team." className="tm-stack tm-stack--tight">
                      <Skeleton height="var(--row)" />
                    </LoadingRegion>
                  </>
                ) : null}

                {detail.isError ? (
                  <>
                    <h2 id="tm-team-detail-heading" className="ppl-card__title ppl-card__title--lg">
                      Team detail
                    </h2>
                    <InlineAlert tone="danger" title="Could not load the team" live>
                      {describePeopleError(detail.error)}
                    </InlineAlert>
                  </>
                ) : null}

                {detail.isSuccess ? (
                  <TeamDetail team={detail.data} organizationSlug={organizationSlug} />
                ) : null}
              </section>
            ) : teams.isSuccess ? (
              <section className="ppl-card" aria-label="Team detail">
                <p className="ppl-dashed-note">
                  No teams have been defined yet. When an admin creates one, its members appear
                  here.
                </p>
              </section>
            ) : null}
          </div>
        </div>
      </div>
    </AppShell>
  );
}

function TeamsList({
  teams,
  selectedId,
  onSelect,
}: {
  teams: readonly TeamView[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  if (teams.length === 0) {
    return <p className="ppl-note">No teams have been defined yet.</p>;
  }
  return (
    <ul className="ppl-soft-list" aria-label="Teams in this organization">
      {teams.map((team) => (
        <li key={team.id}>
          <button
            type="button"
            className="ppl-member"
            aria-pressed={team.id === selectedId}
            onClick={() => onSelect(team.id)}
          >
            <span className="ppl-avatar ppl-avatar--44" aria-hidden="true">
              {initialsOf(team.name)}
            </span>
            <span>
              <span className="ppl-person__name">{team.name}</span>
              <span className="ppl-person__sub">
                {team.memberCount === 1 ? '1 member' : `${team.memberCount} members`}
              </span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function TeamDetail({
  team,
  organizationSlug,
}: {
  team: TeamDetailView;
  organizationSlug: string;
}) {
  return (
    <>
      <div className="ppl-card__head">
        <h2 id="tm-team-detail-heading" className="ppl-card__title ppl-card__title--lg">
          {team.name}
        </h2>
        <span className="ppl-mono ppl-mono--meta">
          {team.members.length} {team.members.length === 1 ? 'member' : 'members'}
        </span>
      </div>

      {team.members.length === 0 ? (
        <p className="ppl-dashed-note">This team has no members yet.</p>
      ) : (
        <div className="ppl-inner-table">
          <div className="ppl-table-head" aria-hidden="true">
            <span className="ppl-col-person">Member</span>
            <span className="ppl-col-owner">Role</span>
            <span className="ppl-col-when">Status</span>
          </div>
          <ul className="ppl-people" aria-label={`Members of ${team.name}`}>
            {team.members.map((member) => (
              <li key={member.membershipId} className="ppl-inner-row">
                <span className="ppl-col-person ppl-person__who">
                  <span className="ppl-avatar ppl-avatar--32" aria-hidden="true">
                    {initialsOf(member.displayName)}
                  </span>
                  <Link
                    href={`/${organizationSlug}/people/${member.membershipId}`}
                    className="ppl-commitment__title"
                  >
                    {member.displayName}
                  </Link>
                </span>
                <span className="ppl-col-owner ppl-cell-strong">
                  {describeInternalRole(member.role).label}
                </span>
                <span className="ppl-col-when">
                  <span
                    className={
                      member.status === 'active' ? 'ppl-status' : 'ppl-status ppl-status--quiet'
                    }
                  >
                    {member.status === 'active' ? 'Active' : member.status}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { fetchTeam, listTeams } from '../../lib/api/people-teams';
import type { TeamDetailView, TeamView } from '../../lib/api/people-teams';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface TeamsScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** Injected in tests. Defaults to the browser client. */
  client?: ApiClient;
}

/**
 * **People teams** — x262, the "teams" surface of module 14 (38-MODULE-MAP §People; planning PEO-03
 * "Team detail"). It reads `GET …/people/teams` (the team list) and, when a team is selected, `GET
 * …/people/teams/:id` (the team's members) — both gated on the server by `work.read`.
 *
 * The decisions are the sibling internal screens':
 * 1. **Authorization is the API's.** A caller without `work.read`, or a cross-tenant/unknown id, gets
 *    the API's 403/404, which `describe()` turns into a sentence in the panel's own alert; the screen
 *    never guesses a capability of its own and never renders blank on a refusal.
 * 2. **No invented data.** The teams, member counts and rosters are the API's projection.
 * 3. **No charts dependency.** Semantic sections and a captioned table carry the data.
 */
export function TeamsScreen({ organizationSlug, organizationName, client }: TeamsScreenProps) {
  const api = client ?? browserApiClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const teams = useQuery({
    queryKey: ['people-teams', organizationSlug],
    queryFn: () => listTeams(api, organizationSlug),
  });

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
      title="Teams"
      description="Named teams in this organization and who is on them."
    >
      <section className="tm-panel tm-stack" aria-labelledby="tm-teams-heading">
        <h2 id="tm-teams-heading" className="tm-eyebrow">
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
            {describe(teams.error)}
          </InlineAlert>
        ) : null}

        {teams.isSuccess ? (
          <TeamsList teams={teams.data.teams} selectedId={selectedId} onSelect={setSelectedId} />
        ) : null}
      </section>

      {selectedId !== null ? (
        <section className="tm-panel tm-stack" aria-labelledby="tm-team-detail-heading">
          <h2 id="tm-team-detail-heading" className="tm-eyebrow">
            Team detail
          </h2>

          {detail.isPending ? (
            <LoadingRegion label="Loading the team." className="tm-stack tm-stack--tight">
              <Skeleton height="var(--row)" />
            </LoadingRegion>
          ) : null}

          {detail.isError ? (
            <InlineAlert tone="danger" title="Could not load the team" live>
              {describe(detail.error)}
            </InlineAlert>
          ) : null}

          {detail.isSuccess ? <TeamDetail team={detail.data} /> : null}
        </section>
      ) : null}
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
    return <p className="tm-prose">No teams have been defined yet.</p>;
  }
  return (
    <table className="tm-table" aria-labelledby="tm-teams-heading">
      <caption className="tm-visually-hidden">Teams in this organization</caption>
      <thead>
        <tr>
          <th scope="col">Team</th>
          <th scope="col">Members</th>
        </tr>
      </thead>
      <tbody>
        {teams.map((team) => (
          <tr key={team.id} aria-selected={team.id === selectedId}>
            <th scope="row">
              <button
                type="button"
                className="tm-button tm-button--text tm-button--compact"
                onClick={() => onSelect(team.id)}
              >
                {team.name}
              </button>
            </th>
            <td className="tm-mono">{team.memberCount}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function TeamDetail({ team }: { team: TeamDetailView }) {
  return (
    <>
      <dl className="tm-detail-list">
        <div className="tm-detail-list__pair">
          <dt>Name</dt>
          <dd>{team.name}</dd>
        </div>
        <div className="tm-detail-list__pair">
          <dt>Members</dt>
          <dd className="tm-mono">{team.members.length}</dd>
        </div>
      </dl>

      <h3 className="tm-eyebrow" id="tm-team-members">
        Members
      </h3>
      {team.members.length === 0 ? (
        <p className="tm-prose">This team has no members yet.</p>
      ) : (
        <table className="tm-table" aria-labelledby="tm-team-members">
          <caption className="tm-visually-hidden">Members of {team.name}</caption>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Role</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {team.members.map((member) => (
              <tr key={member.membershipId}>
                <th scope="row">{member.displayName}</th>
                <td className="tm-mono">{member.role}</td>
                <td className="tm-mono">{member.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

/** Turn a thrown value into a sentence a person can act on. Never leaks a stack or a cause. */
function describe(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Check that it is running.';
  return 'Something went wrong. Try again.';
}

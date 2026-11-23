'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ApiClient } from '../../lib/api/client';
import { fetchTeam } from '../../lib/api/people-teams';
import { teamKey, useTeamsList } from '../people/teams/use-teams';
import { useA6T } from './DueDatePicker';
import { initialsOf } from './OwnerPickerDialog';

export interface PickerTeamsProps {
  readonly api: ApiClient;
  readonly organizationSlug: string;
  /** The picker's search, lower-cased; a team shows when its name holds it. */
  readonly needle: string;
  /** Who may be picked here (the project's people): only they are added from a team. */
  readonly candidateIds: ReadonlySet<string>;
  readonly onAdd: (userIds: readonly string[]) => void;
}

function peopleKey(count: number): string {
  if (count === 1) return 'WorkPeople.teamPeopleOne';
  if (count === 2) return 'WorkPeople.teamPeopleTwo';
  return 'WorkPeople.teamPeopleMany';
}

/**
 * The workspace's teams at the top of a Work people picker (Doers, Supervisor, Watchers; WW4
 * hand-off W-WEB-4 b): a press ticks everyone in the team who belongs to this work's project, and
 * says how many were left out because they are not in it. The team list and each roster are the
 * Teams page's own cached reads (`teamsKey`, `teamKey`), so nothing is read twice. Nothing shows
 * while the workspace has no team or none matches the search.
 */
export function PickerTeams({
  api,
  organizationSlug,
  needle,
  candidateIds,
  onAdd,
}: PickerTeamsProps) {
  const t = useA6T();
  const queries = useQueryClient();
  const teams = useTeamsList(api, organizationSlug);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | undefined>(undefined);
  const rows = (teams.data?.teams ?? []).filter(
    (team) => team.memberCount > 0 && (needle === '' || team.name.toLowerCase().includes(needle)),
  );
  if (rows.length === 0) return null;

  async function add(teamId: string, name: string) {
    setBusy(teamId);
    try {
      const team = await queries.fetchQuery({
        queryKey: teamKey(organizationSlug, teamId),
        queryFn: () => fetchTeam(api, organizationSlug, teamId),
      });
      const everyone = team.members.map((member) => member.userId);
      const here = everyone.filter((userId) => candidateIds.has(userId));
      onAdd(here);
      setNote(
        here.length < everyone.length
          ? t('WorkPeople.teamOutside', { team: name, count: everyone.length - here.length })
          : undefined,
      );
    } catch {
      setNote(t('WorkPeople.teamFailed'));
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <ul className="tm-wk-people" aria-label={t('WorkPeople.teams')}>
        {rows.map((team) => (
          <li key={team.id}>
            <button
              type="button"
              className="tm-wk-person"
              disabled={busy !== null}
              aria-busy={busy === team.id || undefined}
              onClick={() => void add(team.id, team.name)}
            >
              <span className="tm-wk-orb" aria-hidden="true">
                {initialsOf(team.name)}
              </span>
              <span className="tm-wk-person__text">
                <span className="tm-wk-person__name">
                  {t('WorkPeople.addTeam', { team: team.name })}
                </span>
                <span className="tm-wk-person__role">
                  {t(peopleKey(team.memberCount), { count: team.memberCount })}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      {note ? (
        <p className="tm-wk-dialog__lede" role="status">
          {note}
        </p>
      ) : null}
    </>
  );
}

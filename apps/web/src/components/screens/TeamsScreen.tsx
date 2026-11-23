'use client';

import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { useT } from '../../lib/i18n/use-t';
import { useTOr } from '../../lib/i18n/use-t-or';
import { TeachingEmptyState } from '../help/TeachingEmptyState';
import { browserApiClient } from '../../lib/api/browser-client';
import { deleteTeam, fetchTeam, listTeams } from '../../lib/api/people-teams';
import type { TeamDetailView, TeamView } from '../../lib/api/people-teams';
import { useRoleDescription } from '../../lib/use-role-description';
import type { ApiClient } from '../../lib/api/client';
import { useShellCapability } from '../shell/use-shell-capability';
import { ConfirmActionButton } from './ConfirmActionButton';
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
  const t = useT();
  const api = client ?? browserApiClient();
  const [chosenId, setChosenId] = useState<string | null>(null);
  const queryClient = useQueryClient();
  // Fix lane C: Delete team is drawn only for a role that holds `org.manage` (the API's gate).
  const mayManage = useShellCapability(organizationSlug, client)('org.manage');

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
          ? `${t('TeamsScreen.eyebrowPrefix')} ${teamList.length} ${
              teamList.length === 1 ? t('TeamsScreen.teamSingular') : t('TeamsScreen.teamPlural')
            }`
          : t('TeamsScreen.eyebrowBase')
      }
      title={t('TeamsScreen.title')}
      description={t('TeamsScreen.description')}
    >
      <div className="ppl-screen">
        <div className="ppl-body ppl-body--wide-gap">
          <div className="ppl-aside ppl-aside--392">
            <section className="ppl-card" aria-labelledby="tm-teams-heading">
              <h2 id="tm-teams-heading" className="ppl-mono">
                {t('TeamsScreen.teamsHeading')}
              </h2>

              {teams.isPending ? (
                <LoadingRegion
                  label={t('TeamsScreen.loadingTeams')}
                  className="tm-stack tm-stack--tight"
                >
                  <Skeleton height="var(--row)" />
                  <Skeleton height="var(--row)" />
                </LoadingRegion>
              ) : null}

              {teams.isError ? (
                <InlineAlert tone="danger" title={t('TeamsScreen.teamsLoadError')} live>
                  {describePeopleError(teams.error)}
                </InlineAlert>
              ) : null}

              {teams.isSuccess ? (
                <TeamsList teams={teamList} selectedId={selectedId} onSelect={setChosenId} />
              ) : null}
            </section>

            <section className="ppl-card" aria-labelledby="tm-teams-how">
              <h2 id="tm-teams-how" className="ppl-card__title">
                {t('TeamsScreen.howShapedHeading')}
              </h2>
              <p className="ppl-dashed-note">{t('TeamsScreen.howShapedBody')}</p>
            </section>
          </div>

          <div className="ppl-main">
            {selectedId !== null ? (
              <section className="ppl-card" aria-labelledby="tm-team-detail-heading">
                {detail.isPending ? (
                  <>
                    <h2 id="tm-team-detail-heading" className="ppl-card__title ppl-card__title--lg">
                      {t('TeamsScreen.teamDetailHeading')}
                    </h2>
                    <LoadingRegion
                      label={t('TeamsScreen.loadingTeam')}
                      className="tm-stack tm-stack--tight"
                    >
                      <Skeleton height="var(--row)" />
                    </LoadingRegion>
                  </>
                ) : null}

                {detail.isError ? (
                  <>
                    <h2 id="tm-team-detail-heading" className="ppl-card__title ppl-card__title--lg">
                      {t('TeamsScreen.teamDetailHeading')}
                    </h2>
                    <InlineAlert tone="danger" title={t('TeamsScreen.teamLoadError')} live>
                      {describePeopleError(detail.error)}
                    </InlineAlert>
                  </>
                ) : null}

                {detail.isSuccess ? (
                  <TeamDetail
                    team={detail.data}
                    organizationSlug={organizationSlug}
                    removeAction={
                      mayManage ? (
                        <DeleteTeamAction
                          api={api}
                          organizationSlug={organizationSlug}
                          team={detail.data}
                          onDeleted={async (teamId) => {
                            // The list first, so the next selection is never the gone team.
                            await queryClient.invalidateQueries({
                              queryKey: ['people-teams', organizationSlug],
                            });
                            setChosenId(null);
                            queryClient.removeQueries({
                              queryKey: ['people-team', organizationSlug, teamId],
                            });
                          }}
                        />
                      ) : null
                    }
                  />
                ) : null}
              </section>
            ) : teams.isSuccess ? (
              <section className="ppl-card" aria-label={t('TeamsScreen.teamDetailAria')}>
                <p className="ppl-dashed-note">{t('TeamsScreen.noTeamsBody')}</p>
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
  const t = useT();
  if (teams.length === 0) {
    return (
      <TeachingEmptyState
        title={t('teachEmpty.teamsTitle')}
        explanation={t('teachEmpty.teamsBody')}
        helpSlug="invite-your-team"
        helpLabel={t('EmptyStates.howInvitingWorks')}
      />
    );
  }
  return (
    <ul className="ppl-soft-list" aria-label={t('TeamsScreen.teamsListAria')}>
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
                {team.memberCount === 1
                  ? t('TeamsScreen.oneMember')
                  : `${team.memberCount} ${t('TeamsScreen.memberPlural')}`}
              </span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Fix lane C. Delete a team after one confirm; its people stay in the workspace. */
function DeleteTeamAction({
  api,
  organizationSlug,
  team,
  onDeleted,
}: {
  api: ApiClient;
  organizationSlug: string;
  team: TeamDetailView;
  onDeleted: (teamId: string) => Promise<void>;
}) {
  const tOr = useTOr();
  return (
    <ConfirmActionButton
      triggerLabel={tOr('TeamsScreen.deleteTeam', 'Delete team')}
      title={tOr('TeamsScreen.deleteTeamTitle', 'Delete the team “{name}”?')
        .split('{name}')
        .join(team.name)}
      body={tOr(
        'TeamsScreen.deleteTeamBody',
        'Its members stay in the workspace with their projects and work. Only the team goes. This cannot be undone.',
      )}
      confirmLabel={tOr('TeamsScreen.deleteTeamConfirm', 'Delete team')}
      busyLabel={tOr('TeamsScreen.deletingTeam', 'Deleting…')}
      failedTitle={tOr('TeamsScreen.deleteTeamFailed', 'Team not deleted')}
      onConfirm={() => deleteTeam(api, organizationSlug, team.id)}
      onDone={() => void onDeleted(team.id)}
    />
  );
}

function TeamDetail({
  team,
  organizationSlug,
  removeAction,
}: {
  team: TeamDetailView;
  organizationSlug: string;
  removeAction: ReactNode;
}) {
  const t = useT();
  const describeRole = useRoleDescription();
  return (
    <>
      <div className="ppl-card__head">
        <h2 id="tm-team-detail-heading" className="ppl-card__title ppl-card__title--lg">
          {team.name}
        </h2>
        <span className="ppl-mono ppl-mono--meta">
          {team.members.length}{' '}
          {team.members.length === 1
            ? t('TeamsScreen.memberSingular')
            : t('TeamsScreen.memberPlural')}
        </span>
        {removeAction}
      </div>

      {team.members.length === 0 ? (
        <p className="ppl-dashed-note">{t('TeamsScreen.noMembersYet')}</p>
      ) : (
        <div className="ppl-inner-table">
          <div className="ppl-table-head" aria-hidden="true">
            <span className="ppl-col-person">{t('TeamsScreen.memberCol')}</span>
            <span className="ppl-col-owner">{t('TeamsScreen.roleCol')}</span>
            <span className="ppl-col-when">{t('TeamsScreen.statusCol')}</span>
          </div>
          <ul className="ppl-people" aria-label={`${t('TeamsScreen.membersOf')} ${team.name}`}>
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
                  {describeRole(member.role).label}
                </span>
                <span className="ppl-col-when">
                  <span
                    className={
                      member.status === 'active' ? 'ppl-status' : 'ppl-status ppl-status--quiet'
                    }
                  >
                    {member.status === 'active' ? t('TeamsScreen.activeStatus') : member.status}
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

'use client';

import { useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Button, InlineAlert, LoadingRegion, SearchField, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { useT } from '../../lib/i18n/use-t';
import { useTOr } from '../../lib/i18n/use-t-or';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import { pluralPhrase } from '../../lib/i18n/plural';
import { browserApiClient } from '../../lib/api/browser-client';
import type { ApiClient } from '../../lib/api/client';
import { useShellCapability } from '../shell/use-shell-capability';
import { PeopleSectionNav } from '../people/PeopleSectionNav';
import { EyeIcon } from '../work/work-icons';
import { TeamList } from '../people/teams/TeamList';
import { TeamPanel } from '../people/teams/TeamPanel';
import { DeleteTeamDialog, NewTeamDialog } from '../people/teams/TeamDialogs';
import { filterTeams, selectedTeamId, type Candidate } from '../people/teams/teams-model';
import { useTeam, useTeamCandidates, useTeamsList, useTeamWrites } from '../people/teams/use-teams';
import { describePeopleError } from './peopleShared';
import '../people/teams/teams.css';

export interface TeamsScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** Injected in tests. Defaults to the browser client. */
  client?: ApiClient;
  /** Stories: open with this team chosen, as `?team=` does in the app. */
  initialTeamId?: string;
  /** Stories: open with a dialog showing. */
  initialDialog?: 'new' | 'delete';
  /** Stories: what New team opens with. */
  initialDraft?: { readonly name: string; readonly people: readonly Candidate[] };
}

type Dialog = { readonly kind: 'new' } | { readonly kind: 'delete'; readonly teamId: string };

/**
 * **Teams** (Work area v2, W-WEB-4; Figma `WV2-05`, `WV2-06`, `WV2-09` team states). People's own
 * menu on the left (the menu entry Teams lacked), the team list, and the chosen team beside it:
 * rename in place, ⋯ (Rename, Delete team), "Add people to …", and the members as Name · Open
 * work · Remove. "New team" sits in the header with "Search teams". On a phone the list and the
 * team are two pages: a row opens `?team=<id>`, "‹ Teams" goes back.
 *
 * Authorization is the API's: reading needs `work.read`, every write `org.manage`. The writes are
 * drawn only for a role that holds `org.manage` (the shell's capability read); a refusal that
 * still happens is said in place, never as a blank screen.
 */
export function TeamsScreen({
  organizationSlug,
  organizationName,
  client,
  initialTeamId,
  initialDialog,
  initialDraft,
}: TeamsScreenProps) {
  const t = useT();
  const tOr = useTOr();
  const locale = useActiveLocale();
  const api = client ?? browserApiClient();
  const mayManage = useShellCapability(organizationSlug, client)('org.manage');
  const params = useSearchParams();
  const [localChoice, setLocalChoice] = useState<string | null>(initialTeamId ?? null);
  const [query, setQuery] = useState('');
  const [wantPeople, setWantPeople] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(
    initialDialog === 'new' ? { kind: 'new' } : null,
  );
  const [storyDelete, setStoryDelete] = useState(initialDialog === 'delete');

  const list = useTeamsList(api, organizationSlug);
  const teams = list.data?.teams ?? [];
  const shown = filterTeams(teams, query);
  const requested = params?.get('team') ?? localChoice;
  const selectedId = selectedTeamId(shown, requested);
  const team = useTeam(api, organizationSlug, selectedId);
  const candidates = useTeamCandidates(api, organizationSlug, wantPeople || dialog?.kind === 'new');
  const writes = useTeamWrites(api, organizationSlug);
  const deleting =
    dialog?.kind === 'delete'
      ? dialog
      : storyDelete && team.data
        ? { kind: 'delete' as const, teamId: team.data.id }
        : null;

  /**
   * Choose a team (or none: the phone's list). In the app the address follows, so the team can be
   * shared, reloaded and left with Back; Next keeps `useSearchParams` in step with the history
   * API. Outside the app router (`params` is null: a story, a unit test) the choice is local only.
   */
  const choose = (teamId: string | null) => {
    setLocalChoice(teamId);
    if (params === null) return;
    const base = `/${organizationSlug}/people/teams`;
    window.history.pushState(
      null,
      '',
      teamId ? `${base}?team=${encodeURIComponent(teamId)}` : base,
    );
  };
  const count = (key: string, value: number, one: string, other: string) =>
    pluralPhrase(tOr, locale, key, value, { one, other });
  const meta = list.isSuccess
    ? [
        count('TeamsScreen.teamCount', teams.length, '1 team', '{count} teams'),
        ...(teams.length > 0
          ? [count('TeamsScreen.peopleCount', list.data.peopleCount, '1 person', '{count} people')]
          : []),
      ].join(' · ')
    : undefined;

  const newTeam = mayManage ? (
    <Button tone="lime" size="header" onClick={() => setDialog({ kind: 'new' })}>
      {t('TeamsScreen.newTeam')}
    </Button>
  ) : null;

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="people"
      header="compact"
      // Figma WV2-06 phone: an opened team draws its own "‹ Teams" and name; the list's title
      // is not drawn above them.
      phoneHeader={requested !== null ? 'hide' : 'show'}
      title={t('TeamsScreen.title')}
      {...(meta === undefined ? {} : { titleMeta: meta })}
      contextRail={<PeopleSectionNav organizationSlug={organizationSlug} current="teams" />}
      actions={
        <>
          {teams.length > 0 ? (
            <SearchField
              label={t('TeamsScreen.search')}
              placeholder={t('TeamsScreen.search')}
              className="tm-teams-search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          ) : null}
          {newTeam}
        </>
      }
    >
      <div className="tm-teams" data-chosen={requested !== null || undefined}>
        {notice ? (
          <p className="tm-teams__notice" role="status">
            {notice}
          </p>
        ) : null}

        {list.isPending ? (
          <LoadingRegion label={t('TeamsScreen.loading')} className="tm-teams__loading">
            <Skeleton height="var(--app-row)" />
            <Skeleton height="var(--app-row)" />
          </LoadingRegion>
        ) : null}

        {list.isError ? (
          <InlineAlert tone="danger" title={t('TeamsScreen.loadError')} live>
            {describePeopleError(list.error)}
          </InlineAlert>
        ) : null}

        {list.isSuccess && teams.length === 0 ? (
          <section className="tm-team-empty" data-kind="teams" aria-label={t('TeamsScreen.title')}>
            <span className="tm-team-empty__icon" aria-hidden="true">
              <EyeIcon />
            </span>
            <p className="tm-team-empty__text">{t('TeamsScreen.emptyBody')}</p>
            {newTeam}
          </section>
        ) : null}

        {list.isSuccess && teams.length > 0 ? (
          <div className="tm-teams__body">
            <div className="tm-teams__list">
              {shown.length === 0 ? (
                <p className="tm-teams__nomatch">{t('TeamsScreen.noMatch')}</p>
              ) : (
                <TeamList teams={shown} selectedId={selectedId} onChoose={choose} />
              )}
            </div>
            <div className="tm-teams__detail">
              {team.isPending && selectedId !== null ? (
                <LoadingRegion label={t('TeamsScreen.loading')} className="tm-teams__loading">
                  <Skeleton height="var(--app-row)" />
                </LoadingRegion>
              ) : null}
              {team.isError ? (
                <InlineAlert tone="danger" title={t('TeamsScreen.teamLoadError')} live>
                  {describePeopleError(team.error)}
                </InlineAlert>
              ) : null}
              {team.isSuccess ? (
                <TeamPanel
                  organizationSlug={organizationSlug}
                  team={team.data}
                  mayManage={mayManage}
                  candidates={candidates.data}
                  candidatesLoading={candidates.isPending}
                  onWantCandidates={() => setWantPeople(true)}
                  onRename={(name) => writes.rename(team.data.id, name)}
                  onAdd={(people) => writes.addMembers(team.data.id, people)}
                  onRemove={(membershipId) => writes.removeMember(team.data.id, membershipId)}
                  onDelete={() => setDialog({ kind: 'delete', teamId: team.data.id })}
                  onBack={() => choose(null)}
                />
              ) : null}
            </div>
          </div>
        ) : null}
      </div>

      {dialog?.kind === 'new' ? (
        <NewTeamDialog
          api={api}
          organizationSlug={organizationSlug}
          teams={teams}
          candidates={candidates.data}
          candidatesLoading={candidates.isPending}
          onWantCandidates={() => setWantPeople(true)}
          peopleOf={writes.peopleOf}
          onCreate={writes.create}
          onCreated={(created) => {
            setDialog(null);
            setQuery('');
            choose(created.team.id);
            setNotice(created.notAdded.length > 0 ? t('TeamsScreen.someNotAdded') : null);
          }}
          onClose={() => setDialog(null)}
          {...(initialDraft
            ? { initialName: initialDraft.name, initialPeople: initialDraft.people }
            : {})}
        />
      ) : null}

      {deleting && team.data && team.data.id === deleting.teamId ? (
        <DeleteTeamDialog
          team={{ id: team.data.id, name: team.data.name, people: team.data.members.length }}
          onDelete={writes.remove}
          onDeleted={() => {
            setDialog(null);
            setStoryDelete(false);
            choose(null);
          }}
          onClose={() => {
            setDialog(null);
            setStoryDelete(false);
          }}
        />
      ) : null}
    </AppShell>
  );
}

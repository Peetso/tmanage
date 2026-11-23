'use client';

import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ApiClient } from '../../../lib/api/client';
import { listPeople } from '../../../lib/api/people';
import {
  assignMember,
  createTeam,
  deleteTeam,
  fetchTeam,
  listTeams,
  renameTeam,
  unassignMember,
  type TeamView,
} from '../../../lib/api/people-teams';
import type { Candidate } from './teams-model';

/**
 * Teams page reads and writes (W-WEB-4). The keys are the ones the Works list already reads
 * (`['people-teams', slug]`, `['people-team', slug, id]`), so a change here refreshes its Team
 * filter too; the directory's key is refreshed because each person there lists their teams.
 */
export const teamsKey = (slug: string) => ['people-teams', slug] as const;
export const teamKey = (slug: string, teamId: string | null) =>
  ['people-team', slug, teamId] as const;
const peopleKey = (slug: string) => ['people-directory', slug, 'team-candidates'] as const;

/** The directory's page ceiling (`directory.controller.ts` MAX_LIMIT): a studio fits in one read. */
const PEOPLE_LIMIT = 200;

export function useTeamsList(api: ApiClient, slug: string) {
  return useQuery({ queryKey: teamsKey(slug), queryFn: () => listTeams(api, slug) });
}

export function useTeam(api: ApiClient, slug: string, teamId: string | null) {
  return useQuery({
    queryKey: teamKey(slug, teamId),
    queryFn: () => fetchTeam(api, slug, teamId as string),
    enabled: teamId !== null,
  });
}

/** Everyone in the workspace who can be put in a team, read only once a picker opens. */
export function useTeamCandidates(api: ApiClient, slug: string, enabled: boolean) {
  return useQuery({
    queryKey: peopleKey(slug),
    queryFn: async (): Promise<readonly Candidate[]> => {
      const { people } = await listPeople(api, slug, { limit: PEOPLE_LIMIT });
      return people.map((person) => ({
        membershipId: person.membershipId,
        userId: person.userId,
        displayName: person.displayName,
      }));
    },
    enabled,
    staleTime: 60_000,
  });
}

export interface CreatedTeam {
  readonly team: TeamView;
  /** People whose add was refused; the team exists either way. */
  readonly notAdded: readonly Candidate[];
}

/**
 * The team writes. Each one refreshes what it changed; a refusal is thrown to the caller, which
 * says it in place (the API's 409 for a taken name, anything else as "try again").
 */
export function useTeamWrites(api: ApiClient, slug: string) {
  const queryClient = useQueryClient();

  const refresh = useCallback(
    async (teamId: string | null) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: teamsKey(slug) }),
        teamId === null
          ? Promise.resolve()
          : queryClient.invalidateQueries({ queryKey: teamKey(slug, teamId) }),
        queryClient.invalidateQueries({ queryKey: ['people-directory', slug] }),
      ]);
    },
    [queryClient, slug],
  );

  /**
   * Create, then add each person in turn. The API has no "create with members" body, so the team
   * is created first; an add that fails leaves the team in place and is reported, never retried
   * silently (each add is idempotent on the server, so the person can simply be added again).
   */
  const create = useCallback(
    async (name: string, people: readonly Candidate[]): Promise<CreatedTeam> => {
      const team = await createTeam(api, slug, name);
      const notAdded: Candidate[] = [];
      for (const person of people) {
        try {
          await assignMember(api, slug, team.id, person.membershipId);
        } catch {
          notAdded.push(person);
        }
      }
      await refresh(team.id);
      return { team, notAdded };
    },
    [api, slug, refresh],
  );

  const rename = useCallback(
    async (teamId: string, name: string) => {
      await renameTeam(api, slug, teamId, name);
      await refresh(teamId);
    },
    [api, slug, refresh],
  );

  const remove = useCallback(
    async (teamId: string) => {
      await deleteTeam(api, slug, teamId);
      queryClient.removeQueries({ queryKey: teamKey(slug, teamId) });
      await refresh(null);
    },
    [api, slug, queryClient, refresh],
  );

  const addMembers = useCallback(
    async (teamId: string, people: readonly Candidate[]) => {
      try {
        for (const person of people) await assignMember(api, slug, teamId, person.membershipId);
      } finally {
        await refresh(teamId);
      }
    },
    [api, slug, refresh],
  );

  const removeMember = useCallback(
    async (teamId: string, membershipId: string) => {
      await unassignMember(api, slug, teamId, membershipId);
      await refresh(teamId);
    },
    [api, slug, refresh],
  );

  /** A team's people, for "add a team" in the New team people field. */
  const peopleOf = useCallback(
    async (teamId: string): Promise<readonly Candidate[]> => {
      const team = await queryClient.fetchQuery({
        queryKey: teamKey(slug, teamId),
        queryFn: () => fetchTeam(api, slug, teamId),
      });
      return team.members.map((member) => ({
        membershipId: member.membershipId,
        userId: member.userId,
        displayName: member.displayName,
      }));
    },
    [api, slug, queryClient],
  );

  return { create, rename, remove, addMembers, removeMember, peopleOf };
}

/**
 * Teams page (Work area v2, W-WEB-4): the pure rules behind the screen, kept apart from React so
 * each one is provable without a render.
 */
import { ApiRequestError } from '../../../lib/api/errors';
import type { TeamListRowView, TeamMemberView } from '../../../lib/api/people-teams';

/** One person the people field can add: an org member by membership, with a name to show. */
export interface Candidate {
  readonly membershipId: string;
  readonly userId: string;
  readonly displayName: string;
}

/**
 * Initials on a face (Figma `WV2-05`: "PK", and one letter for an Arabic name, "ب"). The same
 * rule as the shell's account face: a name in Arabic script gives its first letter only, because
 * two joined Arabic letters read as a word, not as initials.
 */
export function faceInitials(name: string): string {
  const parts = name.trim().split(/\s+/u).filter(Boolean);
  if (parts.length === 0) return '?';
  const count = /\p{Script=Arabic}/u.test(name) ? 1 : 2;
  return parts
    .slice(0, count)
    .map((part) => Array.from(part)[0] ?? '')
    .join('')
    .toUpperCase();
}

/** The teams whose name holds the search, ignoring case and outer spaces; all when it is blank. */
export function filterTeams(
  teams: readonly TeamListRowView[],
  query: string,
): readonly TeamListRowView[] {
  const needle = query.trim().toLocaleLowerCase();
  if (needle === '') return teams;
  return teams.filter((team) => team.name.toLocaleLowerCase().includes(needle));
}

/**
 * Which team the page shows: the one in the address while it still exists, otherwise the first
 * listed, so the desktop page is never an empty half (Figma `WV2-05`). `null` with no team.
 */
export function selectedTeamId(
  teams: readonly TeamListRowView[],
  requested: string | null,
): string | null {
  if (requested !== null && teams.some((team) => team.id === requested)) return requested;
  return teams[0]?.id ?? null;
}

/** The work the team's people have open, summed for the phone's "5 people · 15 open". */
export function openTotal(members: readonly TeamMemberView[]): number {
  return members.reduce((sum, member) => sum + member.openWorkCount, 0);
}

/**
 * The people a picker offers: everyone not already chosen (or already in the team) whose name
 * holds the typed letters. A person with no name never shows as a blank row.
 */
export function pickable(
  people: readonly Candidate[],
  taken: ReadonlySet<string>,
  query: string,
): readonly Candidate[] {
  const needle = query.trim().toLocaleLowerCase();
  return people.filter(
    (person) =>
      person.displayName.trim() !== '' &&
      !taken.has(person.membershipId) &&
      (needle === '' || person.displayName.toLocaleLowerCase().includes(needle)),
  );
}

/**
 * Add people to the chosen list once each, in the order they were picked. Picking a team adds its
 * people (Figma `WV2-06`: "Add people or a team…"), so the result is still a list of people: a
 * team is a group to pick from, never a member of another team (review D4).
 */
export function addChosen(
  chosen: readonly Candidate[],
  added: readonly Candidate[],
): readonly Candidate[] {
  const seen = new Set(chosen.map((person) => person.membershipId));
  const next = [...chosen];
  for (const person of added) {
    if (seen.has(person.membershipId)) continue;
    seen.add(person.membershipId);
    next.push(person);
  }
  return next;
}

/** A refused write, as the page says it: a taken name, a missing name, or try again. */
export type TeamWriteProblem = 'nameTaken' | 'nameNeeded' | 'writeFailed';

/** RFC 9110: 409 is the API's taken-name conflict, 400 its blank or too-long name. */
export function teamWriteProblem(failure: unknown): TeamWriteProblem {
  if (!(failure instanceof ApiRequestError)) return 'writeFailed';
  if (failure.status === 409) return 'nameTaken';
  if (failure.status === 400) return 'nameNeeded';
  return 'writeFailed';
}

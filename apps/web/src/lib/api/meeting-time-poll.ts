import type { ApiClient } from './client';

/**
 * CAL meeting time-option poll (x298) — an organiser proposes candidate time slots, invitees vote
 * yes/maybe/no on each, and the tally picks the time.
 *
 * `POST .../meetings/:meetingId/time-poll` proposes slots behind `meeting.write` (the API further
 * requires the caller be the organiser); `GET .../time-poll` reads the poll behind `meeting.read`;
 * `PUT .../time-poll/options/:optionId/vote` casts the caller's own vote behind `meeting.read` and
 * is idempotent. The meeting — and, for a vote, the option — is resolved tenant-scoped on the API
 * before the relation check (the Known-trap order), so an unknown or cross-tenant id is a 404: the
 * screen shows a not-found state rather than an empty poll that would confirm the meeting exists.
 */

/** The three answers a member can give on a candidate slot. */
export type MeetingTimePollVoteChoice = 'yes' | 'maybe' | 'no';

/** How many members chose each answer on one candidate slot. */
export interface MeetingTimePollTally {
  readonly yes: number;
  readonly maybe: number;
  readonly no: number;
}

/**
 * One candidate slot as the screen reads it: its bounds (ISO-8601 instants), the caller's own vote
 * (`null` until they vote) and the tally.
 */
export interface MeetingTimePollOptionView {
  readonly id: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly ownVote: MeetingTimePollVoteChoice | null;
  readonly tally: MeetingTimePollTally;
}

/**
 * A meeting's whole time-option poll. Paired `Exact` with the API's `MeetingTimePollView` in the
 * contracts gate (`e2e/contracts/api-web-shapes.ts`): rename or retype a field on either side and
 * `pnpm contracts:check` fails. `organizationId` is deliberately absent — it is never echoed into a
 * response body (`25-AUTH-AND-TENANT-ISOLATION` §7).
 */
export interface MeetingTimePollView {
  readonly meetingId: string;
  readonly options: readonly MeetingTimePollOptionView[];
}

/** A candidate slot to propose. */
export interface NewMeetingTimePollOption {
  readonly startsAt: string;
  readonly endsAt: string;
}

function pollPath(organizationSlug: string, meetingId: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/meetings/${encodeURIComponent(meetingId)}/time-poll`;
}

/** Read a meeting's time-option poll (behind `meeting.read`). */
export async function getMeetingTimePoll(
  client: ApiClient,
  organizationSlug: string,
  meetingId: string,
): Promise<MeetingTimePollView> {
  const { data } = await client.request<MeetingTimePollView>({
    path: pollPath(organizationSlug, meetingId),
  });
  return data;
}

/** Propose candidate slots (behind `meeting.write`, organiser). Returns the poll. */
export async function createMeetingTimePoll(
  client: ApiClient,
  organizationSlug: string,
  meetingId: string,
  options: readonly NewMeetingTimePollOption[],
): Promise<MeetingTimePollView> {
  const { data } = await client.request<MeetingTimePollView>({
    method: 'POST',
    path: pollPath(organizationSlug, meetingId),
    body: { options },
  });
  return data;
}

/** Cast or change the caller's own vote on one candidate slot (behind `meeting.read`). */
export async function voteMeetingTimePollOption(
  client: ApiClient,
  organizationSlug: string,
  meetingId: string,
  optionId: string,
  choice: MeetingTimePollVoteChoice,
): Promise<MeetingTimePollView> {
  const { data } = await client.request<MeetingTimePollView>({
    method: 'PUT',
    path: `${pollPath(organizationSlug, meetingId)}/options/${encodeURIComponent(optionId)}/vote`,
    body: { choice },
  });
  return data;
}

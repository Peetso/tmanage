import type { ApiClient } from './client';

/**
 * CAL-01 / MTG-01 attendees + RSVP (x126) — a meeting's attendees and their answer.
 *
 * A meeting's attendees are a tenant-scoped, meeting-scoped record served under a meeting:
 * `GET .../meetings/:meetingId/attendees` lists them behind `meeting.read`, `POST` invites a member
 * behind `meeting.write`, and `PATCH .../attendees/:attendeeId` sets one attendee's RSVP behind
 * `meeting.write`. The meeting is named by the path and resolved tenant-scoped on the API before the
 * relation check (the Known-trap order), so an unknown or cross-tenant meeting id is a 404 — the
 * screen shows a not-found state rather than an empty list that would confirm the meeting exists.
 */

/** The three answers an attendee can give. */
export type AttendeeRsvp = 'invited' | 'accepted' | 'declined';

/** What a roster row may show: also `tentative` ("Maybe"), which arrives from Google / Outlook. */
export type AttendeeAnswer = AttendeeRsvp | 'tentative';

/**
 * One attendee, as the screen reads it. Paired `Exact` with the API's `MeetingAttendeeView` in the
 * contracts gate (`e2e/contracts/api-web-shapes.ts`): rename or retype a field on either side and
 * `pnpm contracts:check` fails. The member is named by `userId` (the roster's identity), never the
 * internal `membershipId`; `organizationId` is deliberately absent — it is never echoed into a
 * response body (`25-AUTH-AND-TENANT-ISOLATION` §7).
 */
export interface MeetingAttendeeView {
  readonly id: string;
  readonly meetingId: string;
  readonly userId: string;
  readonly rsvp: AttendeeAnswer;
  /** An ISO-8601 instant on the wire. */
  readonly createdAt: string;
}

/** What the invite form sends — the member's `userId`. A request body, not a paired projection. */
export interface InviteAttendeeInput {
  readonly userId: string;
}

/**
 * BK5: a client person on a meeting. Named by `userId` like a member, plus the name and company the
 * roster shows (the member directory cannot resolve a client). Paired `Exact` with the API's
 * `MeetingClientAttendeeView` in the contracts gate.
 */
export interface MeetingClientAttendeeView {
  readonly id: string;
  readonly meetingId: string;
  readonly userId: string;
  readonly displayName: string;
  readonly clientOrganizationId: string;
  readonly clientOrganizationName: string;
  readonly rsvp: AttendeeAnswer;
  readonly createdAt: string;
}

/**
 * BK5: a client person of the meeting's project who may be added ("Clients on <project>"). Paired
 * `Exact` with the API's `ClientAttendeeCandidateView` in the contracts gate.
 */
export interface ClientAttendeeCandidateView {
  readonly userId: string;
  readonly displayName: string;
  readonly clientOrganizationId: string;
  readonly clientOrganizationName: string;
}

/** What the attendee list answers: the members, and (on the first page) the client people. */
export interface MeetingAttendeeList {
  readonly attendees: readonly MeetingAttendeeView[];
  /** Absent only from an older API; the screen reads it as empty. */
  readonly clientAttendees?: readonly MeetingClientAttendeeView[];
}

/** List a meeting's attendees (behind `meeting.read`). */
export async function listMeetingAttendees(
  client: ApiClient,
  organizationSlug: string,
  meetingId: string,
): Promise<MeetingAttendeeList> {
  const { data } = await client.request<MeetingAttendeeList>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/meetings/${encodeURIComponent(meetingId)}/attendees`,
  });
  return data;
}

/** Invite a member to a meeting (behind `meeting.write`). Returns the created attendee (201). */
export async function inviteMeetingAttendee(
  client: ApiClient,
  organizationSlug: string,
  meetingId: string,
  input: InviteAttendeeInput,
): Promise<MeetingAttendeeView> {
  const { data } = await client.request<MeetingAttendeeView>({
    method: 'POST',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/meetings/${encodeURIComponent(meetingId)}/attendees`,
    body: input,
  });
  return data;
}

/** Set an attendee's RSVP (behind `meeting.write`). Returns the updated attendee. */
export async function setMeetingAttendeeRsvp(
  client: ApiClient,
  organizationSlug: string,
  meetingId: string,
  attendeeId: string,
  rsvp: AttendeeRsvp,
): Promise<MeetingAttendeeView> {
  const { data } = await client.request<MeetingAttendeeView>({
    method: 'PATCH',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/meetings/${encodeURIComponent(meetingId)}/attendees/${encodeURIComponent(attendeeId)}`,
    body: { rsvp },
  });
  return data;
}

/** BK5: the client people of this meeting's project who may be added (behind `meeting.read`). */
export async function listClientCandidates(
  client: ApiClient,
  organizationSlug: string,
  meetingId: string,
): Promise<{ readonly candidates: readonly ClientAttendeeCandidateView[] }> {
  const { data } = await client.request<{
    readonly candidates: readonly ClientAttendeeCandidateView[];
  }>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/meetings/${encodeURIComponent(meetingId)}/attendees/client-candidates`,
  });
  return data;
}

/**
 * BK5: invite a client person of the meeting's project (behind `meeting.write`). Sent as
 * `clientUserId`, never `userId` — the API refuses a body carrying both. Returns the attendee (201).
 */
export async function inviteClientAttendee(
  client: ApiClient,
  organizationSlug: string,
  meetingId: string,
  clientUserId: string,
): Promise<MeetingClientAttendeeView> {
  const { data } = await client.request<MeetingClientAttendeeView>({
    method: 'POST',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/meetings/${encodeURIComponent(meetingId)}/attendees`,
    body: { clientUserId },
  });
  return data;
}

/** Remove an attendee, member or client (behind `meeting.write`). 204; 404 when not on the meeting. */
export async function removeMeetingAttendee(
  client: ApiClient,
  organizationSlug: string,
  meetingId: string,
  attendeeId: string,
): Promise<void> {
  await client.request<void>({
    method: 'DELETE',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/meetings/${encodeURIComponent(meetingId)}/attendees/${encodeURIComponent(attendeeId)}`,
  });
}

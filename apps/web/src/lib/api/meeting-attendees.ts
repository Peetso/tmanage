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
  readonly rsvp: AttendeeRsvp;
  /** An ISO-8601 instant on the wire. */
  readonly createdAt: string;
}

/** What the invite form sends — the member's `userId`. A request body, not a paired projection. */
export interface InviteAttendeeInput {
  readonly userId: string;
}

/** List a meeting's attendees (behind `meeting.read`). */
export async function listMeetingAttendees(
  client: ApiClient,
  organizationSlug: string,
  meetingId: string,
): Promise<{ readonly attendees: readonly MeetingAttendeeView[] }> {
  const { data } = await client.request<{ readonly attendees: readonly MeetingAttendeeView[] }>({
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

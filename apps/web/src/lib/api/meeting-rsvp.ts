import type { ApiClient } from './client';

/**
 * CAL meeting RSVP (x240) — a member's own response to a meeting they can see.
 *
 * Distinct from the attendee roster (`meeting-attendees.ts`, an organiser inviting members): this is
 * a member answering for themselves. `GET .../meetings/:meetingId/rsvp` returns the summary (counts
 * and the caller's own response) behind `meeting.read`; `PUT .../meetings/:meetingId/rsvp` sets the
 * caller's own response behind `meeting.write` and is idempotent. The meeting is named by the path
 * and resolved tenant-scoped on the API before the relation check (the Known-trap order), so an
 * unknown or cross-tenant meeting id is a 404 — the screen shows a not-found state rather than an
 * empty summary that would confirm the meeting exists.
 */

/** The three answers a member can give. */
export type MeetingRsvpResponse = 'accepted' | 'declined' | 'tentative';

/**
 * A meeting's RSVP summary, as the screen reads it. Paired `Exact` with the API's `MeetingRsvpView`
 * in the contracts gate (`e2e/contracts/api-web-shapes.ts`): rename or retype a field on either side
 * and `pnpm contracts:check` fails. `response` is the caller's own answer (`null` until they answer);
 * `organizationId` is deliberately absent — it is never echoed into a response body
 * (`25-AUTH-AND-TENANT-ISOLATION` §7).
 */
export interface MeetingRsvpView {
  readonly meetingId: string;
  readonly response: MeetingRsvpResponse | null;
  readonly counts: {
    readonly accepted: number;
    readonly declined: number;
    readonly tentative: number;
  };
}

/** Read a meeting's RSVP summary (behind `meeting.read`). */
export async function getMeetingRsvp(
  client: ApiClient,
  organizationSlug: string,
  meetingId: string,
): Promise<MeetingRsvpView> {
  const { data } = await client.request<MeetingRsvpView>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/meetings/${encodeURIComponent(meetingId)}/rsvp`,
  });
  return data;
}

/** Set the caller's own response (behind `meeting.write`). Returns the updated summary. */
export async function setMeetingRsvp(
  client: ApiClient,
  organizationSlug: string,
  meetingId: string,
  response: MeetingRsvpResponse,
): Promise<MeetingRsvpView> {
  const { data } = await client.request<MeetingRsvpView>({
    method: 'PUT',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/meetings/${encodeURIComponent(meetingId)}/rsvp`,
    body: { response },
  });
  return data;
}
